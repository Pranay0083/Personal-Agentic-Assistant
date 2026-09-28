import { and, eq, inArray } from 'drizzle-orm';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { items, people, pushTokens, users, type Db } from '@hub/db';
import { safeTimeZone } from '@hub/models';
import type { Logger } from '@hub/server';
import { UserSettings } from '@hub/shared';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import { isQuietHours, msUntilQuietEnd } from './quiet';

/**
 * Quiet hours policy: during quiet hours only `vip` goes out. Everything else is
 * DEFERRED (re-enqueued with a delay until quiet hours end), not dropped, so a
 * "Draft ready" at 23:00 arrives at 07:00. Dedupe happens at send time, so a deferred
 * notification still sends at most once.
 */

export type PushSender = {
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
};

export type Dedupe = {
  /** Returns true if this key was not seen before (SET NX). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
};

export type NotifierDeps = {
  db: Db;
  /** null = PUSH_FAKE: log the title only, send nothing. */
  push: PushSender | null;
  dedupe: Dedupe;
  enqueue: (
    queue: typeof QUEUES.notifier,
    data: NotifierJob,
    opts: { jobId: string; delay: number },
  ) => Promise<unknown>;
  now: () => Date;
  log: Logger;
};

export type NotifyOutcome =
  | { status: 'no_user' | 'disabled' | 'duplicate' | 'no_tokens' }
  | { status: 'deferred'; delayMs: number }
  | { status: 'sent'; tokens: number; removed: number; kind: NotifierJob['kind'] }
  | { status: 'sent_fake'; tokens: number; kind: NotifierJob['kind'] };

export const DEDUPE_TTL_SECONDS = 7 * 24 * 3600;
const DEFERRED_FLAG = '_deferred';

async function isVipItem(db: Db, userId: string, itemId: string, vips: string[]): Promise<boolean> {
  const [it] = await db
    .select({ author: items.author, authorAddress: items.authorAddress })
    .from(items)
    .where(eq(items.id, itemId));
  if (!it) return false;
  const addr = it.authorAddress?.toLowerCase();
  const name = it.author?.toLowerCase();
  const list = vips.map((v) => v.toLowerCase());
  if ((addr && list.includes(addr)) || (name && list.includes(name))) return true;
  if (!addr) return false;
  const rows = await db
    .select({ emails: people.emails })
    .from(people)
    .where(and(eq(people.userId, userId), eq(people.isVip, true)));
  return rows.some((r) => r.emails.some((e) => e.toLowerCase() === addr));
}

export async function processNotification(
  deps: NotifierDeps,
  input: NotifierJob,
): Promise<NotifyOutcome> {
  const { db, log } = deps;
  const job = { ...input, data: { ...input.data } };
  const [user] = await db
    .select({ settings: users.settings, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, job.userId));
  if (!user) return { status: 'no_user' };
  const parsed = UserSettings.safeParse(user.settings ?? {});
  const settings = parsed.success ? parsed.data : UserSettings.parse({});
  if (!settings.notificationsEnabled) return { status: 'disabled' };
  const tz = safeTimeZone(user.timezone);

  // Tasks from VIP senders notify as VIP (they go out even during quiet hours).
  let kind = job.kind;
  if (
    kind === 'task' &&
    job.data.itemId &&
    (await isVipItem(db, job.userId, job.data.itemId, settings.vips))
  ) {
    kind = 'vip';
  }

  const now = deps.now();
  const wasDeferred = job.data[DEFERRED_FLAG] === '1';
  if (kind !== 'vip' && !wasDeferred && isQuietHours(now, tz, settings.quietHours)) {
    const delayMs = Math.max(1_000, msUntilQuietEnd(now, tz, settings.quietHours));
    await deps.enqueue(
      QUEUES.notifier,
      { ...job, data: { ...job.data, [DEFERRED_FLAG]: '1' } },
      { jobId: `notify-deferred-${job.dedupeKey.replace(/:/g, '-')}`, delay: delayMs },
    );
    log.info({ userId: job.userId, kind, delayMs }, 'notification deferred for quiet hours');
    return { status: 'deferred', delayMs };
  }

  const dedupeKey = `notify:${job.dedupeKey}`;
  if (!(await deps.dedupe.claim(dedupeKey, DEDUPE_TTL_SECONDS))) return { status: 'duplicate' };

  try {
    const tokens = await db
      .select({ id: pushTokens.id, token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, job.userId));
    if (tokens.length === 0) return { status: 'no_tokens' };

    const data: Record<string, string> = { kind };
    for (const [k, v] of Object.entries(job.data)) if (!k.startsWith('_')) data[k] = v;

    if (!deps.push) {
      // Title only: never log message text.
      log.info(
        { userId: job.userId, kind, title: job.title, tokens: tokens.length },
        'push (fake)',
      );
      return { status: 'sent_fake', tokens: tokens.length, kind };
    }

    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: job.title,
      body: job.body,
      data,
      sound: 'default',
      priority: kind === 'vip' || kind === 'approval' ? 'high' : 'default',
      ...(kind === 'approval' ? { categoryId: 'approval' } : {}),
    }));
    const tickets = await deps.push.send(messages);
    const dead: string[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        const tok = ticket.details.expoPushToken ?? tokens[i]?.token;
        if (tok) dead.push(tok);
      }
    });
    if (dead.length) {
      await db
        .delete(pushTokens)
        .where(and(eq(pushTokens.userId, job.userId), inArray(pushTokens.token, dead)));
    }
    log.info(
      { userId: job.userId, kind, tokens: tokens.length, removed: dead.length },
      'push sent',
    );
    return { status: 'sent', tokens: tokens.length, removed: dead.length, kind };
  } catch (err) {
    // Let the retry try again.
    await deps.dedupe.release(dedupeKey);
    throw err;
  }
}
