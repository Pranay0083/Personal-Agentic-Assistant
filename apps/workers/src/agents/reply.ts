import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, items, proposals } from '@hub/db';
import { parseModelJson } from '@hub/models';
import { GmailSendPayload } from '@hub/shared';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import {
  agentPrincipal,
  check,
  fenceItem,
  firstNameOf,
  isFromMe,
  itemContent,
  jobId,
  loadItemContext,
  referenceLines,
  type AgentDeps,
  type AgentOutcome,
  type ItemContext,
} from './context';
import { REPLY_SYSTEM, ReplyOutput } from './prompts';

const PRINCIPAL = 'agent:reply';

/** RFC 822 Message-ID of the item, if the connector stored one (triage.messageId or a `<…@…>` label). */
export function messageIdOf(item: ItemContext['item']): string | undefined {
  const t = item.triage as { messageId?: unknown } | null;
  if (t && typeof t.messageId === 'string' && /^<[^<>\s]+@[^<>\s]+>$/.test(t.messageId)) {
    return t.messageId;
  }
  const labels = Array.isArray(item.labels) ? (item.labels as unknown[]) : [];
  for (const l of labels) {
    if (typeof l !== 'string') continue;
    const v = l.startsWith('rfc822msgid:') ? l.slice('rfc822msgid:'.length) : l;
    if (/^<[^<>\s]+@[^<>\s]+>$/.test(v)) return v;
  }
  return undefined;
}

const cleanTopic = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\S+@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

export async function runReply(deps: AgentDeps, itemId: string): Promise<AgentOutcome> {
  const { db } = deps;
  const ctx = await loadItemContext(db, itemId);
  if (!ctx) return { status: 'missing' };
  if (ctx.item.kind !== 'email') return { status: 'unsupported_kind' };
  if (isFromMe(ctx)) return { status: 'from_me' };
  // Recipient comes from the DB, never from model output.
  const to = z.email().safeParse(ctx.item.authorAddress?.trim());
  if (!to.success) return { status: 'no_recipient' };

  const userId = ctx.account.userId;
  const accountId = ctx.account.id;
  const p = agentPrincipal(userId, 'reply');
  const target = `item:${itemId}`;
  const idempotencyKey = `reply:${itemId}`;

  for (const [resource, action] of [
    ['email', 'read'],
    ['draft.write', 'write'],
    ['message.send', 'draft'],
  ] as const) {
    const d = await check(deps, p, accountId, resource, action, target);
    if (!d.allow) return { status: 'denied', reason: d.reason };
  }

  const [existing] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(eq(proposals.idempotencyKey, idempotencyKey));
  if (existing) return { status: 'exists', proposalId: existing.id };

  const content = await itemContent(deps, ctx);
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.read',
    target,
    details: { accountId, resource: 'email', bodyIncluded: content.bodyIncluded },
  });

  const res = await deps.router.generate({
    userId,
    agent: 'reply',
    system: REPLY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          referenceLines(ctx.item.receivedAt, ctx.timezone),
          fenceItem('email', content.text),
        ].join('\n\n'),
      },
    ],
    maxTokens: 4096,
    effort: 'medium',
    json: true,
  });
  const out = parseModelJson(res.text, ReplyOutput);

  const subjectBase = (ctx.item.title ?? '').trim();
  const subject = /^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`.trim();
  const inReplyTo = messageIdOf(ctx.item);
  const payload = GmailSendPayload.parse({
    to: [to.data],
    cc: [],
    subject,
    body: out.body.trim(),
    ...(ctx.item.threadId ? { threadId: ctx.item.threadId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
  });
  const topic =
    cleanTopic(out.topic ?? '') ||
    cleanTopic(subjectBase.replace(/^((re|fwd?)\s*:\s*)+/i, '')) ||
    'your message';
  const title = `Reply to ${firstNameOf(ctx.item.author, ctx.item.authorAddress)}: ${topic}`;

  const [row] = await db
    .insert(proposals)
    .values({
      userId,
      accountId,
      agent: PRINCIPAL,
      model: res.model,
      action: 'gmail.send',
      title,
      payload,
      status: 'pending',
      sourceItemId: itemId,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: proposals.idempotencyKey })
    .returning({ id: proposals.id });
  if (!row) return { status: 'exists' };

  await db
    .update(items)
    .set({ statusLabel: 'Draft ready', updatedAt: deps.now() })
    .where(eq(items.id, itemId));
  await audit(db, {
    userId,
    principal: PRINCIPAL,
    action: 'agent.proposal.create',
    target: `proposal:${row.id}`,
    details: {
      itemId,
      accountId,
      action: 'gmail.send',
      model: res.model,
      fallbackUsed: res.fallbackUsed,
    },
  });
  await deps.publishLive(userId, { type: 'proposal.created', proposalId: row.id });
  await deps.publishLive(userId, { type: 'item.updated', itemId });
  const job: NotifierJob = {
    userId,
    kind: 'approval',
    title: 'Draft ready',
    body: title,
    data: { proposalId: row.id, itemId },
    dedupeKey: `proposal:${row.id}`,
  };
  await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'proposal', row.id) });
  return { status: 'proposed', proposalId: row.id };
}
