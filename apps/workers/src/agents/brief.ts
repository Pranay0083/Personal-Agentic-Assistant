import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { accounts, audit, briefs, items, tasks, users } from '@hub/db';
import {
  fenceUntrusted,
  localParts,
  parseModelJson,
  relativeDayLabel,
  safeTimeZone,
} from '@hub/models';
import { can, DATA_RESOURCES } from '@hub/policy';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import {
  agentPrincipal,
  firstNameOf,
  jobId,
  referenceLines,
  resourceForKind,
  type AgentDeps,
  type AgentOutcome,
} from './context';
import { PUSH_TEXT } from '../notifier/text';
import { BRIEF_SYSTEM, BriefOutput } from './prompts';

const PRINCIPAL = 'agent:brief';

export async function runBrief(
  deps: AgentDeps,
  userId: string,
  date: string,
): Promise<AgentOutcome> {
  const { db } = deps;
  const [user] = await db
    .select({ id: users.id, paused: users.paused, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return { status: 'missing' };
  // Paused: can() denies every agent read anyway; stop before touching anything.
  if (user.paused) return { status: 'paused' };
  const tz = safeTimeZone(user.timezone);
  const now = deps.now();
  const today = localParts(now, tz).date;

  const p = agentPrincipal(userId, 'brief');
  const cache = new Map<string, boolean>();
  const mayRead = async (accountId: string, resource: string) => {
    const key = `${accountId}:${resource}`;
    if (!cache.has(key)) cache.set(key, (await can(db, p, accountId, resource, 'read')).allow);
    return cache.get(key)!;
  };
  const mayReadAny = async (accountId: string) => {
    for (const r of DATA_RESOURCES) if (await mayRead(accountId, r)) return true;
    return false;
  };

  const taskRows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueAt: tasks.dueAt,
      project: tasks.project,
      accountId: tasks.accountId,
      sourceItemId: tasks.sourceItemId,
      createdBy: tasks.createdBy,
      kind: items.kind,
      itemAccountId: items.accountId,
      author: items.author,
      authorAddress: items.authorAddress,
      labels: items.labels,
    })
    .from(tasks)
    .leftJoin(items, eq(tasks.sourceItemId, items.id))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'open'),
        or(isNull(tasks.confirmedByUser), eq(tasks.confirmedByUser, true)),
      ),
    )
    .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt))
    .limit(50);

  const visibleTasks: typeof taskRows = [];
  for (const t of taskRows) {
    let ok: boolean;
    if (t.kind && t.itemAccountId) {
      const r = resourceForKind(t.kind);
      ok = !!r && (await mayRead(t.itemAccountId, r));
    } else if (t.accountId) {
      ok = await mayReadAny(t.accountId);
    } else if (t.createdBy.startsWith('agent:')) {
      // An agent extracted it from an account that has since been deleted (account_id and
      // source_item_id were set NULL): its account's policy can no longer be checked.
      ok = false;
    } else {
      ok = true; // the user's own task, not tied to any account
    }
    if (ok) visibleTasks.push(t);
    if (visibleTasks.length >= 10) break;
  }

  const since = new Date(now.getTime() - 24 * 3600_000);
  const itemRows = await db
    .select({
      id: items.id,
      accountId: items.accountId,
      kind: items.kind,
      author: items.author,
      authorAddress: items.authorAddress,
      title: items.title,
      summary: items.summary,
    })
    .from(items)
    .innerJoin(accounts, eq(items.accountId, accounts.id))
    .where(
      and(eq(accounts.userId, userId), eq(items.bucket, 'needs_you'), gte(items.receivedAt, since)),
    )
    .orderBy(sql`${items.receivedAt} desc`)
    .limit(30);
  const taskSources = new Set(visibleTasks.map((t) => t.sourceItemId).filter(Boolean));
  const visibleItems: typeof itemRows = [];
  for (const it of itemRows) {
    const r = resourceForKind(it.kind);
    if (!r || taskSources.has(it.id) || !(await mayRead(it.accountId, r))) continue;
    visibleItems.push(it);
    if (visibleItems.length >= 10) break;
  }

  const data = {
    tasks: visibleTasks.map((t) => {
      const dueDate = t.dueAt ? localParts(t.dueAt, tz).date : null;
      return {
        title: t.title,
        due: dueDate ? relativeDayLabel(dueDate, today) : null,
        overdue: !!t.dueAt && t.dueAt < now,
        // Tasks from mail the user sent are their own promises, not someone else's ask.
        from:
          !sentByUser(t.labels) && (t.author || t.authorAddress)
            ? firstNameOf(t.author, t.authorAddress)
            : null,
        project: t.project,
      };
    }),
    needsYou: visibleItems.map((i) => ({
      from: firstNameOf(i.author, i.authorAddress),
      title: i.title,
      summary: i.summary,
    })),
  };
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.read',
    target: `brief:${date}`,
    details: {
      taskIds: visibleTasks.map((t) => t.id),
      itemIds: visibleItems.map((i) => i.id),
    },
  });

  const res = await deps.router.generate({
    userId,
    agent: 'brief',
    system: BRIEF_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          referenceLines(now, tz),
          `Brief date: ${date}`,
          fenceUntrusted(JSON.stringify(data), 'brief-data'),
        ].join('\n\n'),
      },
    ],
    maxTokens: 4096,
    effort: 'medium',
    json: true,
  });
  const out = parseModelJson(res.text, BriefOutput);
  const headline = out.headline.replace(/\s+/g, ' ').trim().slice(0, 140);
  const bullets = out.bullets.slice(0, 3).map((b) => b.replace(/\s+/g, ' ').trim().slice(0, 200));

  const [row] = await db
    .insert(briefs)
    .values({ userId, date, headline, bullets, model: res.model })
    .onConflictDoUpdate({
      target: [briefs.userId, briefs.date],
      set: { headline, bullets, model: res.model },
    })
    .returning({ id: briefs.id });
  const briefId = row!.id;
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.brief',
    target: `brief:${briefId}`,
    details: { date, bullets: bullets.length, model: res.model, fallbackUsed: res.fallbackUsed },
  });
  await deps.publishLive(userId, { type: 'brief.created', briefId });
  const job: NotifierJob = {
    userId,
    kind: 'brief',
    // Never the headline: it summarises message content.
    ...PUSH_TEXT.brief,
    data: { briefId },
    dedupeKey: `brief:${userId}:${date}`,
  };
  await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'brief', userId, date) });
  return { status: 'created', briefId };
}

function sentByUser(labels: unknown): boolean {
  return Array.isArray(labels) && labels.includes('SENT');
}
