import { eq } from 'drizzle-orm';
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
import { open, type KeyProvider } from '@hub/server/secrets';
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

/** Sent by the account owner: Gmail SENT label or author address equal to the account identity. */
export function isFromMe(ctx: ItemContext): boolean {
  const labels = Array.isArray(ctx.item.labels) ? (ctx.item.labels as string[]) : [];
  if (labels.includes('SENT')) return true;
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
    const [row] = await deps.db.select().from(itemBodies).where(eq(itemBodies.id, item.bodyRef));
    if (row && (!row.expiresAt || row.expiresAt > deps.now())) {
      body = (await open(deps.keys, row)).toString('utf8');
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
