import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { audit, items, people, tasks, type Db } from '@hub/db';
import { fenceUntrusted, parseModelJson } from '@hub/models';
import { can } from '@hub/policy';
import { QUEUES, type AgentJob, type NotifierJob } from '@hub/shared/queues';
import {
  agentPrincipal,
  check,
  fenceItem,
  isFromMe,
  itemContent,
  itemFacts,
  jobId,
  loadItemContext,
  referenceLines,
  resourceForKind,
  signalsOf,
  snippetOf,
  type AgentDeps,
  type AgentOutcome,
  type ItemContext,
  type ItemSignals,
} from './context';
import { PUSH_TEXT } from '../notifier/text';
import { TRIAGE_SYSTEM, TriageOutput } from './prompts';
import { replyTarget } from './reply';

const PRINCIPAL = 'agent:triage';

/** Recent task feedback (title + source author only), limited to accounts triage may read. */
export async function loadFeedback(db: Db, userId: string, limit = 30) {
  const rows = await db
    .select({
      title: tasks.title,
      confirmed: tasks.confirmedByUser,
      accountId: items.accountId,
      kind: items.kind,
      author: items.author,
      authorAddress: items.authorAddress,
    })
    .from(tasks)
    .innerJoin(items, eq(tasks.sourceItemId, items.id))
    .where(and(eq(tasks.userId, userId), isNotNull(tasks.confirmedByUser)))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);
  const p = agentPrincipal(userId, 'triage');
  const allowed = new Map<string, boolean>();
  const out: { verdict: 'confirmed' | 'rejected'; title: string; from: string | null }[] = [];
  for (const r of rows) {
    const resource = resourceForKind(r.kind);
    if (!resource) continue;
    const key = `${r.accountId}:${resource}`;
    if (!allowed.has(key)) {
      allowed.set(key, (await can(db, p, r.accountId, resource, 'read')).allow);
    }
    if (!allowed.get(key)) continue;
    out.push({
      verdict: r.confirmed ? 'confirmed' : 'rejected',
      title: r.title.slice(0, 120),
      from: r.authorAddress?.toLowerCase() ?? r.author,
    });
  }
  return out;
}

export async function isVipSender(db: Db, ctx: ItemContext): Promise<boolean> {
  const addr = ctx.item.authorAddress?.toLowerCase();
  const name = ctx.item.author?.toLowerCase();
  const vips = ctx.settings.vips.map((v) => v.toLowerCase());
  if ((addr && vips.includes(addr)) || (name && vips.includes(name))) return true;
  if (!addr) return false;
  const vipPeople = await db
    .select({ emails: people.emails })
    .from(people)
    .where(and(eq(people.userId, ctx.account.userId), eq(people.isVip, true)));
  return vipPeople.some((p) => p.emails.some((e) => e.toLowerCase() === addr));
}

/**
 * Applies trusted provider signals on top of the model's decision: a mention, a review
 * request, an assignment or a pending RSVP always needs the user, with a consistent chip.
 * Signals only ever raise an item to needs_you; they never hide one.
 */
export function applySignals(
  out: Pick<TriageOutput, 'bucket' | 'statusLabel'>,
  s: ItemSignals,
): { bucket: TriageOutput['bucket']; statusLabel: string | null | undefined; forced: boolean } {
  const label = s.blocking
    ? `Blocking ${s.blocking} people`
    : s.reviewRequested
      ? 'Review requested'
      : s.assigned
        ? 'Assigned to you'
        : s.rsvpNeeded
          ? 'RSVP needed'
          : null;
  const must = s.mention || s.reviewRequested || s.assigned || s.rsvpNeeded;
  if (!must) return { bucket: out.bucket, statusLabel: out.statusLabel, forced: false };
  const modelLabel =
    out.bucket === 'needs_you' && out.statusLabel && !/^fyi$/i.test(out.statusLabel.trim())
      ? out.statusLabel
      : null;
  return {
    bucket: 'needs_you',
    statusLabel: label ?? modelLabel ?? 'Mentioned you',
    forced: out.bucket !== 'needs_you',
  };
}

export async function runTriage(deps: AgentDeps, itemId: string): Promise<AgentOutcome> {
  const { db } = deps;
  const ctx = await loadItemContext(db, itemId);
  if (!ctx) return { status: 'missing' };
  const userId = ctx.account.userId;
  const p = agentPrincipal(userId, 'triage');
  const resource = resourceForKind(ctx.item.kind);
  if (!resource) return { status: 'unsupported_kind' };
  const target = `item:${itemId}`;

  const read = await check(deps, p, ctx.account.id, resource, 'read', target);
  if (!read.allow) return { status: 'denied', reason: read.reason };

  if (isFromMe(ctx)) {
    // The user's own message: no triage, but look for promises they made.
    await deps.enqueue(QUEUES.agents, { agent: 'extractor', itemId } satisfies AgentJob, {
      jobId: jobId('extractor', itemId),
    });
    await audit(db, {
      userId,
      principal: PRINCIPAL,
      action: 'agent.triage.skipped',
      target,
      details: { reason: 'from_me' },
    });
    return { status: 'from_me' };
  }

  const content = await itemContent(deps, ctx);
  const feedback = await loadFeedback(db, userId);
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.read',
    target,
    details: {
      accountId: ctx.account.id,
      resource,
      bodyIncluded: content.bodyIncluded,
      feedbackCount: feedback.length,
    },
  });

  const res = await deps.router.generate({
    userId,
    agent: 'triage',
    system: TRIAGE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          referenceLines(ctx.item.receivedAt, ctx.timezone),
          itemFacts(ctx),
          feedback.length ? fenceUntrusted(JSON.stringify(feedback), 'feedback') : '',
          fenceItem(ctx.item.kind, content.text),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    maxTokens: 4096,
    effort: 'low',
    json: true,
  });
  const parsed = parseModelJson(res.text, TriageOutput);
  const signaled = applySignals(parsed, signalsOf(ctx.item));
  const out = { ...parsed, bucket: signaled.bucket, statusLabel: signaled.statusLabel };
  const summary = out.summary.replace(/\s+/g, ' ').trim().slice(0, 200);
  const statusLabel =
    out.bucket === 'ignore'
      ? null
      : out.statusLabel?.replace(/\s+/g, ' ').trim().slice(0, 32) || null;
  const expectsReply = out.bucket === 'needs_you' && out.expectsReply;

  await db
    .update(items)
    .set({
      bucket: out.bucket,
      summary,
      statusLabel,
      triage: {
        bucket: out.bucket,
        summary,
        expectsReply,
        reason: signaled.forced ? 'provider signal' : (out.reason?.slice(0, 200) ?? null),
        // Keep the provider snippet: `summary` now holds the triage line.
        snippet: snippetOf(ctx.item),
        model: res.model,
        provider: res.provider,
        fallbackUsed: res.fallbackUsed,
        at: deps.now().toISOString(),
      },
      updatedAt: deps.now(),
    })
    .where(eq(items.id, itemId));
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.triage',
    target,
    details: { bucket: out.bucket, expectsReply, model: res.model, fallbackUsed: res.fallbackUsed },
  });
  await deps.publishLive(userId, { type: 'item.updated', itemId });

  if (out.bucket === 'needs_you') {
    await deps.enqueue(QUEUES.agents, { agent: 'extractor', itemId } satisfies AgentJob, {
      jobId: jobId('extractor', itemId),
    });
    // Only where the reply agent can answer (Gmail, Outlook, Slack) with a stored target.
    if (expectsReply && replyTarget(ctx)) {
      await deps.enqueue(QUEUES.agents, { agent: 'reply', itemId } satisfies AgentJob, {
        jobId: jobId('reply', itemId),
      });
    }
  } else if (out.bucket === 'fyi' && (await isVipSender(db, ctx))) {
    // needs_you items from VIPs notify through their task (the notifier upgrades it to vip).
    const job: NotifierJob = {
      userId,
      kind: 'vip',
      // Generic text only: push leaves our systems (see NotifierJob).
      ...PUSH_TEXT.vipMessage,
      data: { itemId },
      dedupeKey: `vip:${itemId}`,
    };
    await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'vip', itemId) });
  }
  return { status: 'triaged', bucket: out.bucket, expectsReply };
}
