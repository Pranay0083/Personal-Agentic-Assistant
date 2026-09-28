import { randomBytes, randomUUID } from 'node:crypto';
import { JsonFileStore, MemoryStore, defaultFakePath, fixture, type Store } from '../lib/index';
import type {
  GraphChat,
  GraphChatMessage,
  GraphDriveItem,
  GraphEvent,
  GraphMessage,
} from './graph-types';

/**
 * Fake Microsoft 365 tenants for CONNECTORS_FAKE=1 (local demo) and tests. The file store at
 * `<repo>/.dev/fake-microsoft.json` is shared by the api, gateway, workers and the
 * `fake:microsoft` script. Content is synthetic.
 *
 * Every change bumps the user's `seq`; fake delta tokens are seq numbers, and tokens below
 * `minSeq` answer 410 (expired) like Graph does.
 */

export type FakeFolder = 'inbox' | 'sentitems';

export type FakeUser = {
  key: string;
  id: string;
  tenantId: string;
  upn: string;
  mail: string | null;
  displayName: string;
  nickname: string;
  personal: boolean;
  revoked: boolean;
  seq: number;
  minSeq: number;
  messages: { seq: number; folder: FakeFolder; message: GraphMessage }[];
  events: { seq: number; event: GraphEvent }[];
  chats: GraphChat[];
  chatMessages: { chatId: string; message: GraphChatMessage }[];
  driveItems: { seq: number; item: GraphDriveItem }[];
};

/**
 * Fake subscriptions, as Graph would hold them. The fake keeps `clientState` (the secret) so
 * the dev script can sign its notifications; the real connector never stores it.
 */
export type FakeSubscription = {
  id: string;
  userKey: string;
  resource: string;
  changeType: string;
  clientState: string;
  notificationUrl: string;
  expirationDateTime: string;
};

export type FakeMsState = {
  version: 1;
  connectCounter: number;
  users: Record<string, FakeUser>;
  subscriptions: Record<string, FakeSubscription>;
};

type SeedFile = {
  users: {
    id: string;
    tenantId: string;
    upn: string;
    mail: string | null;
    displayName: string;
    nickname: string;
    personal: boolean;
    messages: { folder: FakeFolder; ageMinutes: number; message: Omit<GraphMessage, 'id'> }[];
    events: { startInHours: number; durationMinutes: number; event: Omit<GraphEvent, 'id'> }[];
    chats: GraphChat[];
    chatMessages: { chatId: string; ageMinutes: number; message: Omit<GraphChatMessage, 'id'> }[];
    driveItems: { ageMinutes: number; item: Omit<GraphDriveItem, 'id'> }[];
  }[];
};

export const fakeId = (prefix: string) =>
  `${prefix}${randomBytes(18).toString('base64url').replace(/[-_]/g, 'A')}`;
const iso = (ms: number) => new Date(ms).toISOString();
/** Graph dateTimeTimeZone in UTC (no offset), as returned with outlook.timezone="UTC". */
const utcDt = (ms: number) => ({ dateTime: iso(ms).replace('Z', '0000'), timeZone: 'UTC' });

function mailMessage(
  folder: FakeFolder,
  m: Omit<GraphMessage, 'id'>,
  at: number,
  id = fakeId('AAMkAD'),
): GraphMessage {
  return {
    ...m,
    id,
    receivedDateTime: iso(at),
    sentDateTime: iso(at - 5_000),
    conversationId: m.conversationId ?? fakeId('AAQkAD'),
    internetMessageId: m.internetMessageId ?? `<${randomUUID()}@fake.outlook.example>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    parentFolderId: folder === 'inbox' ? 'AQMkInbox' : 'AQMkSentItems',
    isDraft: false,
    sender: m.sender ?? m.from ?? null,
  };
}

export function seedFakeMsState(now = Date.now()): FakeMsState {
  const seed = fixture<SeedFile>(import.meta.url, 'fake-tenants.json');
  const users: Record<string, FakeUser> = {};
  for (const u of seed.users) {
    let seq = 1;
    const key = u.upn.toLowerCase();
    users[key] = {
      key,
      id: u.id,
      tenantId: u.tenantId,
      upn: u.upn,
      mail: u.mail,
      displayName: u.displayName,
      nickname: u.nickname,
      personal: u.personal,
      revoked: false,
      seq: 0,
      minSeq: 0,
      messages: u.messages.map((m) => ({
        seq: seq++,
        folder: m.folder,
        message: mailMessage(m.folder, m.message, now - m.ageMinutes * 60_000),
      })),
      events: u.events.map((e) => {
        const start = now + e.startInHours * 3600_000;
        const id = fakeId('AAMkEv');
        return {
          seq: seq++,
          event: {
            ...e.event,
            id,
            start: utcDt(start),
            end: utcDt(start + e.durationMinutes * 60_000),
            createdDateTime: iso(now - 86_400_000),
            lastModifiedDateTime: iso(now - 3600_000),
            iCalUId: fakeId('040000'),
            webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`,
          },
        };
      }),
      chats: u.chats,
      chatMessages: u.chatMessages.map((c) => {
        const at = now - c.ageMinutes * 60_000;
        return {
          chatId: c.chatId,
          message: {
            ...c.message,
            id: String(at),
            chatId: c.chatId,
            createdDateTime: iso(at),
            lastModifiedDateTime: iso(at),
            deletedDateTime: null,
            replyToId: null,
            webUrl: null,
          },
        };
      }),
      driveItems: u.driveItems.map((d) => {
        const at = now - d.ageMinutes * 60_000;
        const id = fakeId('01FAKE');
        return {
          seq: seq++,
          item: {
            ...d.item,
            id,
            createdDateTime: iso(at - 86_400_000),
            lastModifiedDateTime: iso(at),
            webUrl: `https://contoso-my.sharepoint.example/personal/files/${encodeURIComponent(d.item.name ?? id)}`,
          },
        };
      }),
    };
    users[key]!.seq = seq;
    users[key]!.minSeq = 0;
  }
  return { version: 1, connectCounter: 0, users, subscriptions: {} };
}

export type NewFakeMail = {
  from: string;
  fromName?: string;
  subject: string;
  body: string;
  html?: boolean;
  folder?: FakeFolder;
};

export class FakeMicrosoftStore {
  constructor(private readonly store: Store<FakeMsState>) {}

  read(): FakeMsState {
    return this.store.read();
  }

  update<R>(fn: (s: FakeMsState) => R): R {
    return this.store.update(fn);
  }

  keys(): string[] {
    return Object.keys(this.read().users);
  }

  user(key: string): FakeUser | undefined {
    return this.read().users[key.toLowerCase()];
  }

  userById(id: string): FakeUser | undefined {
    return Object.values(this.read().users).find((u) => u.id === id);
  }

  /** Which fake user the consent screen signs in as: the hint, else round-robin. */
  pickForConnect(loginHint?: string): string {
    return this.update((s) => {
      const hint = loginHint?.toLowerCase();
      if (hint && s.users[hint]) return hint;
      const keys = Object.keys(s.users);
      const pick = keys[s.connectCounter % keys.length]!;
      s.connectCounter += 1;
      return pick;
    });
  }

  setRevoked(key: string, revoked: boolean) {
    this.update((s) => {
      const u = s.users[key.toLowerCase()];
      if (u) u.revoked = revoked;
    });
  }

  /** Every delta token issued so far answers 410 (simulates an expired sync state). */
  expireDelta(key: string) {
    this.update((s) => {
      const u = s.users[key.toLowerCase()];
      if (u) {
        u.seq += 1;
        u.minSeq = u.seq;
      }
    });
  }

  addMail(key: string, m: NewFakeMail, now = Date.now()): GraphMessage {
    return this.update((s) => {
      const u = mustUser(s, key);
      const folder = m.folder ?? 'inbox';
      const message = mailMessage(
        folder,
        {
          subject: m.subject,
          bodyPreview: m.body.slice(0, 255),
          body: m.html
            ? { contentType: 'html', content: m.body }
            : { contentType: 'text', content: m.body },
          from: { emailAddress: { name: m.fromName ?? m.from, address: m.from } },
          toRecipients: [{ emailAddress: { name: u.displayName, address: u.mail ?? u.upn } }],
          ccRecipients: [],
          importance: 'normal',
          inferenceClassification: 'focused',
          categories: [],
        },
        now,
      );
      u.seq += 1;
      u.messages.push({ seq: u.seq, folder, message });
      return message;
    });
  }

  /** Appends a sent message (sendMail / reply) with the given Graph message fields. */
  addSent(key: string, message: Omit<GraphMessage, 'id'>, now = Date.now()): GraphMessage {
    return this.update((s) => {
      const u = mustUser(s, key);
      const m = mailMessage('sentitems', message, now);
      u.seq += 1;
      u.messages.push({ seq: u.seq, folder: 'sentitems', message: m });
      return m;
    });
  }

  addChatMessage(
    key: string,
    c: { chatId?: string; fromName: string; fromId?: string; text: string },
    now = Date.now(),
  ): { chat: GraphChat; message: GraphChatMessage } {
    return this.update((s) => {
      const u = mustUser(s, key);
      if (u.personal) throw new Error('personal Microsoft accounts have no Teams chats');
      const chat = c.chatId ? u.chats.find((x) => x.id === c.chatId) : u.chats[0];
      if (!chat) throw new Error(`no fake chat ${c.chatId ?? ''} for ${u.key}`);
      const message: GraphChatMessage = {
        id: String(now),
        chatId: chat.id,
        messageType: 'message',
        createdDateTime: iso(now),
        lastModifiedDateTime: iso(now),
        deletedDateTime: null,
        replyToId: null,
        webUrl: null,
        from: {
          user: {
            id: c.fromId ?? '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
            displayName: c.fromName,
            userIdentityType: 'aadUser',
          },
        },
        body: { contentType: 'text', content: c.text },
      };
      u.chatMessages.push({ chatId: chat.id, message });
      return { chat, message };
    });
  }

  addDriveChange(
    key: string,
    f: { name: string; byName: string; byEmail?: string },
    now = Date.now(),
  ): GraphDriveItem {
    return this.update((s) => {
      const u = mustUser(s, key);
      const existing = u.driveItems.find((d) => d.item.name === f.name);
      const item: GraphDriveItem = {
        ...(existing?.item ?? {
          id: fakeId('01FAKE'),
          name: f.name,
          size: 1024,
          createdDateTime: iso(now),
          file: { mimeType: 'application/octet-stream' },
          parentReference: { driveId: `b!${u.id}`, path: '/drive/root:' },
          webUrl: `https://contoso-my.sharepoint.example/personal/files/${encodeURIComponent(f.name)}`,
        }),
        lastModifiedDateTime: iso(now),
        lastModifiedBy: {
          user: {
            id: randomUUID(),
            displayName: f.byName,
            ...(f.byEmail ? { email: f.byEmail } : {}),
          },
        },
      };
      u.seq += 1;
      if (existing) {
        existing.seq = u.seq;
        existing.item = item;
      } else {
        u.driveItems.push({ seq: u.seq, item });
      }
      return item;
    });
  }

  recordSubscription(sub: FakeSubscription) {
    this.update((s) => {
      s.subscriptions[sub.id] = sub;
    });
  }

  /** Newest live fake subscription of a user whose resource matches. */
  findSubscription(key: string, match: (resource: string) => boolean, now = Date.now()) {
    return this.findSubscriptions(key, match, now)[0];
  }

  /**
   * Every live subscription on the user's resource, newest first. Several Hub accounts (e.g.
   * different Hub users in dev) can subscribe to the same mailbox, and Graph notifies each.
   */
  findSubscriptions(key: string, match: (resource: string) => boolean, now = Date.now()) {
    const s = this.read();
    return Object.values(s.subscriptions)
      .filter((x) => x.userKey === key.toLowerCase() && match(x.resource))
      .filter((x) => Date.parse(x.expirationDateTime) > now)
      .sort((a, b) => b.expirationDateTime.localeCompare(a.expirationDateTime));
  }
}

function mustUser(s: FakeMsState, key: string): FakeUser {
  const u = s.users[key.toLowerCase()];
  if (!u) throw new Error(`no fake Microsoft user ${key}`);
  return u;
}

export const DEFAULT_FAKE_MS_PATH = () => defaultFakePath('microsoft');

let shared: FakeMicrosoftStore | null = null;

/** The shared file-backed store (<repo>/.dev/fake-microsoft.json). */
export function defaultFakeMsStore(): FakeMicrosoftStore {
  shared ??= new FakeMicrosoftStore(
    new JsonFileStore(DEFAULT_FAKE_MS_PATH(), () => seedFakeMsState()),
  );
  return shared;
}

/** In-memory store for tests. */
export function memoryFakeMsStore(now = Date.now()): FakeMicrosoftStore {
  return new FakeMicrosoftStore(new MemoryStore(() => seedFakeMsState(now)));
}
