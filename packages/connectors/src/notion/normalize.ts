import type { NormalizedItem } from '../types';
import { richText } from './blocks';
import type { NotionPage } from './client';

/** One synced page: metadata plus the flattened body. Carries what normalize needs. */
export type NotionRecord = {
  page: NotionPage;
  /** Flattened blocks. Untrusted; never log. */
  text: string;
  truncated: boolean;
  /** The connected user (accounts.meta.ownerUserId), for `fromMe`. */
  ownerUserId: string | null;
  /** Ids of users @-mentioned (structured mention objects) in the page's blocks. */
  mentions?: string[];
  /** Last editor, when the integration may read user information. */
  editor?: { name: string | null; email: string | null } | null;
};

const SUMMARY_CHARS = 240;

export function pageTitle(page: NotionPage): string | null {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title') {
      const t = richText(prop.title).trim();
      return t || null;
    }
  }
  return null;
}

export function notionPageUrl(page: NotionPage): string {
  return page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`;
}

export function normalizeNotion(r: NotionRecord): NormalizedItem | null {
  const { page } = r;
  if (page.object !== 'page' || page.in_trash || page.archived) return null;
  const body = r.text.trim();
  const summary = body ? body.replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS) : null;
  const labels = [`notion:page:${page.id}`];
  if (page.parent?.type) labels.push(`notion:parent:${page.parent.type}`);
  if (r.truncated) labels.push('notion:truncated');
  // Trusted signals: from Notion's metadata (editor id, mention objects), never from text.
  const fromMe = !!r.ownerUserId && page.last_edited_by?.id === r.ownerUserId;
  if (fromMe) labels.push('hub:from_me');
  if (r.ownerUserId && r.mentions?.includes(r.ownerUserId)) labels.push('hub:mention');
  return {
    kind: 'note',
    externalId: page.id,
    threadId: page.id,
    author: r.editor?.name ?? null,
    authorAddress: r.editor?.email ?? null,
    title: pageTitle(page) ?? 'Untitled',
    summary,
    body: body || null,
    url: notionPageUrl(page),
    labels,
    receivedAt: new Date(page.last_edited_time),
    fromMe,
  };
}
