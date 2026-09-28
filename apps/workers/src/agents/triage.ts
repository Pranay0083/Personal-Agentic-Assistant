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
  jobId,
  loadItemContext,
  referenceLines,
  resourceForKind,
  snippetOf,
  type AgentDeps,
  type AgentOutcome,
  type ItemContext,
} from './context';
import { TRIAGE_SYSTEM, TriageOutput } from './prompts';

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
  const out = parseModelJson(res.text, TriageOutput);
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
        reason: out.reason?.slice(0, 200) ?? null,
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
    if (expectsReply && ctx.item.kind === 'email' && ctx.item.authorAddress) {
      await deps.enqueue(QUEUES.agents, { agent: 'reply', itemId } satisfies AgentJob, {
        jobId: jobId('reply', itemId),
      });
    }
  } else if (out.bucket === 'fyi' && (await isVipSender(db, ctx))) {
    // needs_you items from VIPs notify through their task (the notifier upgrades it to vip).
    const job: NotifierJob = {
      userId,
      kind: 'vip',
      title: `${ctx.item.author ?? 'VIP'} wrote`,
      body: summary,
      data: { itemId },
      dedupeKey: `vip:${itemId}`,
    };
    await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'vip', itemId) });
  }
  return { status: 'triaged', bucket: out.bucket, expectsReply };
}
