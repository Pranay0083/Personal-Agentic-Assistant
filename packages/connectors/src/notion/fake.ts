import { randomBytes, randomUUID } from 'node:crypto';
import { defaultFakePath, JsonFileStore, type Store } from '../lib/fake';
import type { FetchFn } from '../lib/http';

/**
 * Fake Notion for CONNECTORS_FAKE=1 (local demo) and tests: a JSON store at
 * `<repo>/.dev/fake-notion.json` served through a fetch that speaks the Notion REST shapes,
 * so the real client, pagination and block flattening run unchanged. Synthetic content only.
 */

export type FakeBlock = {
  id: string;
  type: string;
  text?: string;
  checked?: boolean;
  /** Renders a user mention before the text (a structured mention, like Notion's "@Name"). */
  mention?: { id: string; name: string };
  children?: FakeBlock[];
};

export type FakeNotionUser = { id: string; name: string; email: string };

export type FakeNotionWorkspace = {
  id: string;
  name: string;
  botId: string;
  owner: FakeNotionUser;
  members: FakeNotionUser[];
};

export type FakeNotionPage = {
  id: string;
  workspaceId: string;
  title: string;
  createdTime: string;
  lastEditedTime: string;
  createdBy: string;
  lastEditedBy: string;
  inTrash: boolean;
  blocks: FakeBlock[];
};

export type FakeNotionState = {
  version: 1;
  connectCounter: number;
  workspaces: FakeNotionWorkspace[];
  pages: FakeNotionPage[];
  /** Workspace ids whose grant was revoked: every call answers 401. */
  revoked: string[];
};

/** Notion timestamps are rounded down to the minute. */
export const notionTime = (ms: number) => {
  const d = new Date(ms);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
};

const b = (type: string, text?: string, extra: Partial<FakeBlock> = {}): FakeBlock => ({
  id: randomUUID(),
  type,
  ...(text !== undefined ? { text } : {}),
  ...extra,
});

export function seedFakeNotion(now = Date.now()): FakeNotionState {
  const alex = { id: 'u-alex-0001', name: 'Alex Kim', email: 'alex@company.example' };
  const priya = { id: 'u-priya-0002', name: 'Priya Raman', email: 'priya@company.example' };
  const acme: FakeNotionWorkspace = {
    id: 'ws-acme-0001',
    name: 'Acme Product',
    botId: 'bot-acme-0001',
    owner: alex,
    members: [priya],
  };
  const home: FakeNotionWorkspace = {
    id: 'ws-home-0002',
    name: 'Alex personal',
    botId: 'bot-home-0002',
    owner: { ...alex, email: 'alex@home.example' },
    members: [],
  };
  const hours = (h: number) => notionTime(now - h * 3600_000);
  const page = (
    ws: FakeNotionWorkspace,
    title: string,
    h: number,
    by: string,
    blocks: FakeBlock[],
  ): FakeNotionPage => ({
    id: randomUUID(),
    workspaceId: ws.id,
    title,
    createdTime: hours(h + 24),
    lastEditedTime: hours(h),
    createdBy: by,
    lastEditedBy: by,
    inTrash: false,
    blocks,
  });
  return {
    version: 1,
    connectCounter: 0,
    workspaces: [acme, home],
    revoked: [],
    pages: [
      page(acme, 'Q4 launch plan', 3, priya.id, [
        b('heading_1', 'Goals'),
        b('paragraph', 'Ship the mobile beta to 200 users before the offsite.'),
        b('to_do', ' finalise pricing page copy', {
          checked: false,
          mention: { id: alex.id, name: alex.name },
        }),
        b('to_do', 'Priya: book the venue', { checked: true }),
        b('bulleted_list_item', 'Risks', {
          children: [b('bulleted_list_item', 'App review may take a week')],
        }),
      ]),
      page(acme, 'Weekly sync notes', 20, alex.id, [
        b('heading_2', 'Action items'),
        b('numbered_list_item', 'Send the Q3 numbers to finance'),
        b('numbered_list_item', 'Review the onboarding flow'),
      ]),
      page(home, 'Reading list', 30, alex.id, [
        b('bulleted_list_item', 'Designing Data-Intensive Applications'),
      ]),
    ],
  };
}

export function fakeNotionStore(file = defaultFakePath('notion')): Store<FakeNotionState> {
  return new JsonFileStore<FakeNotionState>(file, () => seedFakeNotion());
}

/** Picks the workspace the fake consent "grants": a matching hint, else round-robin. */
export function pickFakeWorkspace(store: Store<FakeNotionState>, hint?: string) {
  return store.update((s) => {
    const byHint = hint
      ? s.workspaces.find(
          (w) =>
            w.id === hint || w.name.toLowerCase() === hint.toLowerCase() || w.owner.email === hint,
        )
      : undefined;
    if (byHint) return byHint;
    const ws = s.workspaces[s.connectCounter % s.workspaces.length]!;
    s.connectCounter++;
    return ws;
  });
}

/** Edits (appends a paragraph to) or creates a page. Used by `fake:notion`. */
export function editFakePage(
  store: Store<FakeNotionState>,
  p: {
    workspaceId?: string;
    pageId?: string;
    title?: string;
    text: string;
    by?: string;
    todo?: boolean;
    /** @-mention the workspace owner in the new block. */
    mention?: boolean;
  },
  now = Date.now(),
): { page: FakeNotionPage; created: boolean; workspace: FakeNotionWorkspace } {
  return store.update((s) => {
    const existing = p.pageId ? s.pages.find((x) => x.id === p.pageId) : undefined;
    const ws =
      s.workspaces.find((w) => w.id === (existing?.workspaceId ?? p.workspaceId)) ??
      s.workspaces[0]!;
    const editor = p.by ?? ws.members[0]?.id ?? ws.owner.id;
    const mention = p.mention ? { mention: { id: ws.owner.id, name: ws.owner.name } } : {};
    const block = p.todo
      ? b('to_do', p.text, { checked: false, ...mention })
      : b('paragraph', p.text, mention);
    if (existing) {
      existing.blocks.push(block);
      if (p.title) existing.title = p.title;
      existing.lastEditedTime = notionTime(now);
      existing.lastEditedBy = editor;
      return { page: existing, created: false, workspace: ws };
    }
    const page: FakeNotionPage = {
      id: randomUUID(),
      workspaceId: ws.id,
      title: p.title ?? 'Untitled',
      createdTime: notionTime(now),
      lastEditedTime: notionTime(now),
      createdBy: editor,
      lastEditedBy: editor,
      inTrash: false,
      blocks: [block],
    };
    s.pages.push(page);
    return { page, created: true, workspace: ws };
  });
}

const rt = (text: string) => [{ type: 'text', text: { content: text }, plain_text: text }];

function toBlock(fb: FakeBlock) {
  const data: Record<string, unknown> =
    fb.type === 'child_page' || fb.type === 'child_database'
      ? { title: fb.text ?? '' }
      : fb.type === 'divider'
        ? {}
        : {
            rich_text: [
              ...(fb.mention
                ? [
                    {
                      type: 'mention',
                      mention: { type: 'user', user: { object: 'user', id: fb.mention.id } },
                      plain_text: `@${fb.mention.name}`,
                    },
                  ]
                : []),
              ...rt(fb.text ?? ''),
            ],
            ...(fb.type === 'to_do' ? { checked: !!fb.checked } : {}),
          };
  return {
    object: 'block',
    id: fb.id,
    type: fb.type,
    has_children: !!fb.children?.length,
    in_trash: false,
    [fb.type]: data,
  };
}

function toPage(p: FakeNotionPage) {
  return {
    object: 'page',
    id: p.id,
    created_time: p.createdTime,
    last_edited_time: p.lastEditedTime,
    created_by: { object: 'user', id: p.createdBy },
    last_edited_by: { object: 'user', id: p.lastEditedBy },
    in_trash: p.inTrash,
    parent: { type: 'workspace', workspace: true },
    url: `https://www.notion.so/fake-${p.id.replace(/-/g, '')}`,
    properties: { title: { id: 'title', type: 'title', title: rt(p.title) } },
  };
}

function findBlock(blocks: FakeBlock[], id: string): FakeBlock | undefined {
  for (const blk of blocks) {
    if (blk.id === id) return blk;
    const inner = blk.children ? findBlock(blk.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

function page<T>(all: T[], cursor: string | null | undefined, size: number) {
  const start = cursor ? Number(cursor) || 0 : 0;
  const results = all.slice(start, start + size);
  const more = start + size < all.length;
  return {
    object: 'list',
    results,
    has_more: more,
    next_cursor: more ? String(start + size) : null,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string) =>
  json(status, { object: 'error', status, code, message: code });

/** A fetch answering like api.notion.com from the fake store. */
export function fakeNotionFetch(store: Store<FakeNotionState>): FetchFn {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string' && init.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const s = store.read();
    const path = url.pathname;

    if (method === 'POST' && path === '/v1/oauth/token') {
      if (!headers.get('authorization')?.startsWith('Basic ')) return err(401, 'invalid_client');
      const m = /^fake-notion:(.+)$/.exec(String(body.code ?? ''));
      const ws = m ? s.workspaces.find((w) => w.id === m[1]) : undefined;
      if (body.grant_type !== 'authorization_code' || !ws)
        return json(400, { error: 'invalid_grant' });
      if (s.revoked.includes(ws.id))
        store.update((st) => void (st.revoked = st.revoked.filter((x) => x !== ws.id)));
      return json(200, {
        access_token: `fake-notion.${ws.id}.${randomBytes(6).toString('hex')}`,
        token_type: 'bearer',
        refresh_token: null,
        bot_id: ws.botId,
        workspace_id: ws.id,
        workspace_name: ws.name,
        workspace_icon: null,
        owner: {
          type: 'user',
          user: {
            object: 'user',
            id: ws.owner.id,
            name: ws.owner.name,
            type: 'person',
            person: { email: ws.owner.email },
          },
        },
        duplicated_template_id: null,
        request_id: randomUUID(),
      });
    }
    if (method === 'POST' && path === '/v1/oauth/revoke')
      return json(200, { request_id: randomUUID() });

    const m = /^Bearer fake-notion\.([^.]+)\./.exec(headers.get('authorization') ?? '');
    const ws = m ? s.workspaces.find((w) => w.id === m[1]) : undefined;
    if (!ws || s.revoked.includes(ws.id)) return err(401, 'unauthorized');
    if (!headers.get('notion-version')) return err(400, 'missing_version');

    if (method === 'POST' && path === '/v1/search') {
      const pages = s.pages
        .filter((p) => p.workspaceId === ws.id && !p.inTrash)
        .sort((a, c) => c.lastEditedTime.localeCompare(a.lastEditedTime))
        .map(toPage);
      return json(
        200,
        page(pages, body.start_cursor as string | undefined, Number(body.page_size ?? 100)),
      );
    }
    const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (method === 'GET' && children) {
      const id = decodeURIComponent(children[1]!);
      const wsPages = s.pages.filter((p) => p.workspaceId === ws.id);
      const pg = wsPages.find((p) => p.id === id);
      const blocks =
        pg?.blocks ?? wsPages.map((p) => findBlock(p.blocks, id)).find(Boolean)?.children;
      if (!blocks) return err(404, 'object_not_found');
      const size = Number(url.searchParams.get('page_size') ?? 100);
      return json(200, page(blocks.map(toBlock), url.searchParams.get('start_cursor'), size));
    }
    const user = /^\/v1\/users\/([^/]+)$/.exec(path);
    if (method === 'GET' && user) {
      const u = [ws.owner, ...ws.members].find((x) => x.id === decodeURIComponent(user[1]!));
      if (!u) return err(404, 'object_not_found');
      return json(200, {
        object: 'user',
        id: u.id,
        type: 'person',
        name: u.name,
        person: { email: u.email },
      });
    }
    return err(404, 'invalid_request_url');
  }) as FetchFn;
}
