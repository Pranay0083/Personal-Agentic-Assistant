import { createHash } from 'node:crypto';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { audit, items, tasks } from '@hub/db';
import {
  daysBetween,
  isIsoDate,
  localParts,
  parseModelJson,
  relativeDayLabel,
  zonedTimeToUtc,
} from '@hub/models';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import {
  agentPrincipal,
  check,
  fenceItem,
  isFromMe,
  itemContent,
  itemFacts,
  itemRef,
  jobId,
  loadItemContext,
  referenceLines,
  resourceForKind,
  signalsOf,
  type AgentDeps,
  type AgentOutcome,
  type ItemContext,
} from './context';
import { PUSH_TEXT } from '../notifier/text';
import { EXTRACTOR_SYSTEM, ExtractorOutput, PROMISES_ADDENDUM } from './prompts';
import { isVipSender } from './triage';

const PRINCIPAL = 'agent:extractor';
/** Date-only deadlines ("by Thursday") are due at end of the working day, local time. */
export const DEFAULT_DUE_TIME = '17:00';

/** Lowercased, punctuation-free, whitespace-collapsed title: "Send the Q3 deck." = "send the q3 deck". */
export function normalizeTaskTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Dedupe key for an extracted task: keyed by the normalized title, not its position, so a
 * retried run whose output comes back in a different order adds no duplicates.
 */
export function extractorDedupeKey(itemId: string, title: string): string {
  const hash = createHash('sha256').update(normalizeTaskTitle(title)).digest('hex').slice(0, 32);
  return `extractor:${itemId}:${hash}`;
}

/** Turns the model's local due date/time into a UTC instant; rejects implausible dates. */
export function resolveDueAt(
  due: string | null | undefined,
  dueTime: string | null | undefined,
  refDate: string,
  timezone: string,
): Date | null {
  if (!due || !isIsoDate(due)) return null;
  const diff = daysBetween(refDate, due);
  if (diff < -1 || diff > 730) return null;
  return zonedTimeToUtc(due, dueTime ?? DEFAULT_DUE_TIME, timezone);
}

/**
 * The task a trusted provider signal implies, if any: a requested review ("Review
 * api#231"), an assignment ("Unblock PROJ-482" when it blocks people, else
 * "PROJ-482: <title>") or a pending RSVP. Built from connector labels and the item title
 * only, so no model call is needed and the title is the same on every run.
 */
export function signalTask(ctx: ItemContext): string | null {
  const s = signalsOf(ctx.item);
  const ref = itemRef(ctx.item)?.ref;
  const title = (ctx.item.title ?? '').replace(/\s+/g, ' ').trim();
  if ((ctx.item.kind === 'ticket' || ctx.item.kind === 'code') && ref) {
    if (s.reviewRequested) return `Review ${ref}`;
    if (s.assigned) {
      if (s.blocking) return `Unblock ${ref}`;
      const rest = title.replace(ref, '').replace(/^[\s:·-]+/, '');
      return rest ? `${ref}: ${rest}`.slice(0, 120) : `Work on ${ref}`;
    }
  }
  if (ctx.item.kind === 'event' && s.rsvpNeeded && title) return `RSVP to ${title}`.slice(0, 120);
  return null;
}

export async function runExtractor(deps: AgentDeps, itemId: string): Promise<AgentOutcome> {
  const { db } = deps;
  const ctx = await loadItemContext(db, itemId);
  if (!ctx) return { status: 'missing' };
  const userId = ctx.account.userId;
  const accountId = ctx.account.id;
  const p = agentPrincipal(userId, 'extractor');
  const resource = resourceForKind(ctx.item.kind);
  if (!resource) return { status: 'unsupported_kind' };
  const target = `item:${itemId}`;

  const read = await check(deps, p, accountId, resource, 'read', target);
  if (!read.allow) return { status: 'denied', reason: read.reason };

  const fromMe = isFromMe(ctx);
  // A reply to a request that already produced a task ("Yes, I'll send it Wednesday")
  // restates that task; extracting it again would duplicate it.
  if (
    fromMe &&
    ctx.item.threadId &&
    (await threadHasOpenTask(deps, userId, accountId, ctx.item.threadId))
  ) {
    await audit(db, {
      userId,
      principal: PRINCIPAL,
      action: 'agent.extract.skipped',
      target,
      details: { reason: 'thread_has_open_task' },
    });
    return { status: 'skipped', reason: 'thread already has an open task' };
  }
  const refDate = localParts(ctx.item.receivedAt, ctx.timezone).date;
  const fromSignal = fromMe ? null : signalTask(ctx);
  const res = fromSignal
    ? {
        model: null,
        found: [{ title: fromSignal, due: null, dueTime: null, project: null, confidence: 1 }],
      }
    : await extractWithModel(deps, ctx, fromMe);
  const found = res.found.slice(0, 5);
  if (fromSignal) {
    await audit(db, {
      userId,
      principal: PRINCIPAL,
      action: 'agent.read',
      target,
      details: { accountId, resource, bodyIncluded: false, mode: 'signal' },
    });
  }

  if (found.length === 0) {
    await audit(db, {
      userId,
      principal: PRINCIPAL,
      action: 'agent.extract',
      target,
      details: { tasks: 0, model: res.model },
    });
    if (!fromMe && ctx.item.bucket === 'needs_you' && (await isVipSender(db, ctx))) {
      const job: NotifierJob = {
        userId,
        kind: 'vip',
        ...PUSH_TEXT.vipNeedsYou,
        data: { itemId },
        dedupeKey: `vip:${itemId}`,
      };
      await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'vip', itemId) });
    }
    return { status: 'no_tasks' };
  }

  const write = await check(deps, p, accountId, 'task.create', 'write', target);
  if (!write.allow) return { status: 'denied', reason: write.reason };
  // `ask` (Cautious preset): agent tasks already land unreviewed (confirmed_by_user NULL) and
  // the user confirms or rejects them, so the task itself is the approval request.

  const created: string[] = [];
  for (const t of found) {
    const dueAt = resolveDueAt(t.due, t.dueTime, refDate, ctx.timezone);
    const title = t.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    const [row] = await db
      .insert(tasks)
      .values({
        userId,
        accountId,
        title,
        dueAt,
        project: t.project?.trim().slice(0, 80) || null,
        sourceItemId: itemId,
        confidence: t.confidence ?? null,
        createdBy: PRINCIPAL,
        // Title-based: re-running the extractor on the same item never duplicates a task,
        // whatever order the model returns them in.
        dedupeKey: extractorDedupeKey(itemId, title),
      })
      .onConflictDoNothing({ target: [tasks.userId, tasks.dedupeKey] })
      .returning({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt });
    if (!row) continue;
    created.push(row.id);
    await audit(db, {
      userId,
      principal: PRINCIPAL,
      action: 'agent.task.create',
      target: `task:${row.id}`,
      details: {
        itemId,
        accountId,
        model: res.model,
        needsApproval: write.needsApproval,
        hasDue: !!row.dueAt,
      },
    });
    await deps.publishLive(userId, { type: 'task.created', taskId: row.id });
    const dueLabel = row.dueAt
      ? relativeDayLabel(
          localParts(row.dueAt, ctx.timezone).date,
          localParts(deps.now(), ctx.timezone).date,
        )
      : null;
    const job: NotifierJob = {
      userId,
      kind: 'task',
      // Never the task title: it is model output over message text.
      ...PUSH_TEXT.task(dueLabel),
      data: { taskId: row.id, itemId },
      dedupeKey: `task:${row.id}`,
    };
    await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'task', row.id) });
  }

  if (created.length > 0 && !fromMe) {
    // "Draft ready" (reply agent) wins over "Task created".
    await db
      .update(items)
      .set({ statusLabel: 'Task created', updatedAt: deps.now() })
      .where(
        and(
          eq(items.id, itemId),
          or(isNull(items.statusLabel), ne(items.statusLabel, 'Draft ready')),
        ),
      );
    await deps.publishLive(userId, { type: 'item.updated', itemId });
  }
  return { status: 'extracted', created: created.length };
}

async function threadHasOpenTask(
  deps: { db: AgentDeps['db'] },
  userId: string,
  accountId: string,
  threadId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(items, eq(tasks.sourceItemId, items.id))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'open'),
        eq(items.accountId, accountId),
        eq(items.threadId, threadId),
      ),
    )
    .limit(1);
  return !!row;
}

async function extractWithModel(deps: AgentDeps, ctx: ItemContext, fromMe: boolean) {
  const resource = resourceForKind(ctx.item.kind);
  const content = await itemContent(deps, ctx);
  await audit(deps.db, {
    userId: ctx.account.userId,
    principal: PRINCIPAL,
    action: 'agent.read',
    target: `item:${ctx.item.id}`,
    details: {
      accountId: ctx.account.id,
      resource,
      bodyIncluded: content.bodyIncluded,
      mode: fromMe ? 'promises' : 'requests',
    },
  });
  const res = await deps.router.generate({
    userId: ctx.account.userId,
    agent: 'extractor',
    system: fromMe ? `${EXTRACTOR_SYSTEM}\n${PROMISES_ADDENDUM}` : EXTRACTOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          referenceLines(ctx.item.receivedAt, ctx.timezone),
          itemFacts(ctx),
          fromMe ? 'Mode: promises' : 'Mode: requests',
          fenceItem(ctx.item.kind, content.text),
        ].join('\n\n'),
      },
    ],
    maxTokens: 4096,
    effort: 'low',
    json: true,
  });
  const out = parseModelJson(res.text, ExtractorOutput);
  return { model: res.model as string | null, found: out.tasks };
}
