import { and, eq } from 'drizzle-orm';
import { accounts, audit, itemBodies, items, users, type Db } from '@hub/db';
import {
  fenceUntrusted,
  localParts,
  safeTimeZone,
  WEEKDAY_NAMES,
  type ModelRouter,
} from '@hub/models';
import { can, type Principal } from '@hub/policy';
import type { Logger } from '@hub/server';
import { itemBodyContext, open, type KeyProvider } from '@hub/server/secrets';
import { UserSettings, type DataResource } from '@hub/shared';
import type { LiveEvent, QueueName } from '@hub/shared/queues';

export type Enqueue = (
  queue: QueueName,
  data: unknown,
  opts?: { jobId?: string; delay?: number },
) => Promise<unknown>;

export type AgentDeps = {
  db: Db;
  router: ModelRouter;
  enqueue: Enqueue;
  publishLive: (userId: string, event: LiveEvent) => Promise<void>;
  now: () => Date;
  /** Decrypts item bodies (sealed into item_bodies by the sync worker). */
  keys: KeyProvider;
  log?: Logger;
};

export type AgentOutcome = { status: string; [k: string]: unknown };

/** BullMQ rejects custom job ids containing ':' (unless exactly 3 parts), so we join with '-'. */
export const jobId = (...parts: string[]) => parts.join('-');

const KIND_RESOURCE: Record<string, DataResource> = {
  email: 'email',
  chat: 'chat',
  ticket: 'tickets',
  note: 'notes',
  event: 'calendar',
  file: 'files',
  code: 'code',
};

/** Policy resource for reading an item of this kind. */
export function resourceForKind(kind: string): DataResource | null {
  return KIND_RESOURCE[kind] ?? null;
}

export const agentPrincipal = (userId: string, name: string): Principal => ({
  kind: 'agent',
  userId,
  name,
});

export type ItemContext = NonNullable<Awaited<ReturnType<typeof loadItemContext>>>;

/** Loads an item with its account and owner. */
export async function loadItemContext(db: Db, itemId: string) {
  const [row] = await db
    .select({
      item: items,
      account: {
        id: accounts.id,
        userId: accounts.userId,
        provider: accounts.provider,
        externalId: accounts.externalId,
      },
      user: {
        id: users.id,
        timezone: users.timezone,
        settings: users.settings,
        paused: users.paused,
      },
    })
    .from(items)
    .innerJoin(accounts, eq(items.accountId, accounts.id))
    .innerJoin(users, eq(accounts.userId, users.id))
    .where(eq(items.id, itemId));
  if (!row) return null;
  return {
    ...row,
    settings: parseSettings(row.user.settings),
    timezone: safeTimeZone(row.user.timezone),
  };
}

export function parseSettings(raw: unknown): UserSettings {
  const res = UserSettings.safeParse(raw ?? {});
  return res.success ? res.data : UserSettings.parse({});
}

/** The item's labels (strings only). */
export function labelsOf(item: ItemContext['item']): string[] {
  return Array.isArray(item.labels)
    ? (item.labels as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
}

/** Value of the first `<prefix><value>` label, e.g. labelValue(labels, 'slack:channel:'). */
export function labelValue(labels: string[], prefix: string): string | undefined {
  const l = labels.find((x) => x.startsWith(prefix));
  return l === undefined ? undefined : l.slice(prefix.length);
}

/**
 * Trusted facts about an item, set by the connector from provider metadata (not from
 * message text): see the label conventions in @hub/connectors `NormalizedItem.labels`.
 * Signals use the `hub:` namespace so every provider can set them the same way:
 * `hub:mention` (the user is @-mentioned), `hub:dm` (1:1 conversation),
 * `hub:review_requested`, `hub:assigned`, `hub:blocking:<n>` (people or issues waiting),
 * `hub:rsvp_needed`, `hub:from_me`.
 */
export type ItemSignals = {
  mention: boolean;
  dm: boolean;
  reviewRequested: boolean;
  assigned: boolean;
  blocking: number | null;
  rsvpNeeded: boolean;
};

export function signalsOf(item: ItemContext['item']): ItemSignals {
  const labels = labelsOf(item);
  const blocking = Number(labelValue(labels, 'hub:blocking:'));
  return {
    mention: labels.includes('hub:mention'),
    dm: labels.includes('hub:dm'),
    reviewRequested: labels.includes('hub:review_requested'),
    assigned: labels.includes('hub:assigned'),
    blocking: Number.isInteger(blocking) && blocking > 0 && blocking < 1000 ? blocking : null,
    rsvpNeeded: labels.includes('hub:rsvp_needed'),
  };
}

export type ItemRef = { ref: string; type: 'pull request' | 'issue' | 'Jira issue' };

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;

/** Short reference for a ticket or PR: `api#231` (GitHub) or `PROJ-482` (Jira). */
export function itemRef(item: ItemContext['item']): ItemRef | null {
  const labels = labelsOf(item);
  const key = labelValue(labels, 'jira:key:');
  if (key && JIRA_KEY.test(key)) return { ref: key, type: 'Jira issue' };
  const repo = GITHUB_REPO.exec(labelValue(labels, 'github:repo:') ?? '')?.[1];
  const num = labelValue(labels, 'github:number:');
  if (repo && num && /^\d{1,9}$/.test(num)) {
    const type = labelValue(labels, 'github:type:') === 'pr' ? 'pull request' : 'issue';
    return { ref: `${repo}#${num}`, type };
  }
  return null;
}

/**
 * Trusted lines about the item for the prompt, outside the fence: built only from fixed
 * strings and validated label values, never from message text.
 */
export function itemFacts(ctx: ItemContext): string {
  const s = signalsOf(ctx.item);
  const ref = itemRef(ctx.item);
  const signals = [
    s.mention && 'mentions you',
    s.dm && 'direct message',
    s.reviewRequested && 'review requested from you',
    s.assigned && 'assigned to you',
    s.blocking && `blocking ${s.blocking} people`,
    s.rsvpNeeded && 'RSVP needed',
  ].filter((x): x is string => !!x);
  return [
    `Source: ${ctx.account.provider} ${ctx.item.kind}`,
    ref ? `Reference: ${ref.ref} (${ref.type})` : null,
    signals.length ? `Signals: ${signals.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sent by the account owner: Gmail SENT label, the `hub:from_me` label, or author address
 * equal to the account identity.
 */
export function isFromMe(ctx: ItemContext): boolean {
  const labels = labelsOf(ctx.item);
  if (labels.includes('SENT') || labels.includes('hub:from_me')) return true;
  const a = ctx.item.authorAddress?.toLowerCase();
  return !!a && a === ctx.account.externalId.toLowerCase();
}

/**
 * Checks `can()` and audits a denial. Returns true if allowed.
 * A paused user makes every agent check deny, so callers simply stop.
 */
export async function check(
  deps: AgentDeps,
  p: Principal,
  accountId: string,
  resource: string,
  action: 'read' | 'draft' | 'write',
  target: string,
) {
  const decision = await can(deps.db, p, accountId, resource, action);
  if (!decision.allow) {
    await audit(deps.db, {
      userId: p.userId,
      principal: `agent:${p.kind === 'agent' ? p.name : 'unknown'}`,
      action: 'agent.denied',
      target,
      details: { accountId, resource, action, reason: decision.reason },
    });
  }
  return decision;
}

/** The item's original provider snippet (triage keeps it when it rewrites `items.summary`). */
export function snippetOf(item: ItemContext['item']): string | null {
  const t = item.triage as { snippet?: unknown } | null;
  if (t && typeof t.snippet === 'string') return t.snippet;
  return item.summary;
}

/**
 * Builds the untrusted text for one item. With `keepBodiesLocal` only title + snippet are
 * sent; the body is never decrypted. Returns whether the body was included (for audit).
 */
export async function itemContent(
  deps: AgentDeps,
  ctx: ItemContext,
): Promise<{ text: string; bodyIncluded: boolean }> {
  const { item } = ctx;
  let body: string | null = null;
  if (!ctx.settings.keepBodiesLocal && item.bodyRef) {
    const [row] = await deps.db
      .select()
      .from(itemBodies)
      .where(and(eq(itemBodies.id, item.bodyRef), eq(itemBodies.accountId, item.accountId)));
    if (row && (!row.expiresAt || row.expiresAt > deps.now())) {
      body = (await open(deps.keys, row, itemBodyContext(item.accountId))).toString('utf8');
    }
  }
  const from = [item.author, item.authorAddress ? `<${item.authorAddress}>` : null]
    .filter(Boolean)
    .join(' ');
  const text = [
    `From: ${from || 'unknown'}`,
    `Subject: ${item.title ?? ''}`,
    '',
    (body ?? snippetOf(item) ?? '').slice(0, 20_000),
  ].join('\n');
  return { text, bodyIncluded: body !== null };
}

export function fenceItem(kind: string, text: string) {
  return fenceUntrusted(text, kind);
}

/** Trusted header lines every agent prompt starts with. */
export function referenceLines(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  return [
    `Timezone: ${timezone}`,
    `Reference date: ${p.date} (${WEEKDAY_NAMES[p.weekday]})`,
    `Reference time: ${p.time}`,
  ].join('\n');
}

export function firstNameOf(author: string | null, address: string | null): string {
  const name = author?.replace(/["<].*$/, '').trim();
  if (name) return name.split(/\s+/)[0]!;
  const local = address?.split('@')[0]?.split(/[._+-]/)[0];
  return local ? local[0]!.toUpperCase() + local.slice(1) : 'them';
}
