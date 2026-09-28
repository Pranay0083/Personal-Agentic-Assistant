import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, items, proposals } from '@hub/db';
import { parseModelJson } from '@hub/models';
import { EmailSendPayload, SlackPostPayload, type ProposalAction } from '@hub/shared';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import {
  agentPrincipal,
  check,
  fenceItem,
  firstNameOf,
  isFromMe,
  itemContent,
  jobId,
  labelsOf,
  labelValue,
  loadItemContext,
  referenceLines,
  type AgentDeps,
  type AgentOutcome,
  type ItemContext,
} from './context';
import { PUSH_TEXT } from '../notifier/text';
import { CHAT_REPLY_SYSTEM, REPLY_SYSTEM, ReplyOutput } from './prompts';

const PRINCIPAL = 'agent:reply';

/** RFC 822 Message-ID of the item, if the connector stored one (triage.messageId or a `<…@…>` label). */
export function messageIdOf(item: ItemContext['item']): string | undefined {
  const t = item.triage as { messageId?: unknown } | null;
  if (t && typeof t.messageId === 'string' && /^<[^<>\s]+@[^<>\s]+>$/.test(t.messageId)) {
    return t.messageId;
  }
  for (const l of labelsOf(item)) {
    const v = l.startsWith('rfc822msgid:') ? l.slice('rfc822msgid:'.length) : l;
    if (/^<[^<>\s]+@[^<>\s]+>$/.test(v)) return v;
  }
  return undefined;
}

// Provider ids, validated before they go into a payload (they come from connector labels).
const OUTLOOK_ID = /^[A-Za-z0-9+/=_-]{1,512}$/;
const SLACK_CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;

/**
 * Where a reply to this item goes, taken only from the stored item (author address and
 * connector labels), never from model output or message text. Null: no reply channel.
 */
export type ReplyTarget =
  | {
      action: Extract<ProposalAction, 'gmail.send' | 'outlook.send'>;
      to: string;
      inReplyTo?: string;
      threadId?: string;
    }
  | { action: 'slack.post'; channel: string; threadTs?: string; channelName: string | null };

export function replyTarget(ctx: ItemContext): ReplyTarget | null {
  const { item, account } = ctx;
  const labels = labelsOf(item);
  if (item.kind === 'email' && (account.provider === 'gmail' || account.provider === 'microsoft')) {
    const to = z.email().safeParse(item.authorAddress?.trim());
    if (!to.success) return null;
    const threadId = item.threadId ?? undefined;
    if (account.provider === 'gmail') {
      const inReplyTo = messageIdOf(item);
      return {
        action: 'gmail.send',
        to: to.data,
        ...(threadId ? { threadId } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
      };
    }
    const id = labelValue(labels, 'outlook:id:');
    return {
      action: 'outlook.send',
      to: to.data,
      ...(threadId ? { threadId } : {}),
      ...(id && OUTLOOK_ID.test(id) ? { inReplyTo: id } : {}),
    };
  }
  if (item.kind === 'chat' && account.provider === 'slack') {
    const channel = labelValue(labels, 'slack:channel:');
    if (!channel || !SLACK_CHANNEL.test(channel)) return null;
    const thread = labelValue(labels, 'slack:thread:');
    const ts = labelValue(labels, 'slack:ts:');
    // Reply in the existing thread; otherwise start one under the message. In a DM, an
    // unthreaded message gets a plain reply.
    const threadTs =
      thread && SLACK_TS.test(thread)
        ? thread
        : !channel.startsWith('D') && ts && SLACK_TS.test(ts)
          ? ts
          : undefined;
    if (!threadTs && !channel.startsWith('D')) return null;
    const name =
      labelValue(labels, 'slack:channel_name:') ??
      (item.title?.startsWith('#') ? item.title.slice(1) : undefined);
    return {
      action: 'slack.post',
      channel,
      ...(threadTs ? { threadTs } : {}),
      channelName: name && /^[\w.-]{1,80}$/.test(name) ? name : null,
    };
  }
  return null;
}

const cleanTopic = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\S+@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/**
 * Removes Slack control sequences from drafted text: `<!channel>`, `<!here>`, `<@U…>` user
 * pings, `<#C…>` channel links and `<https://…|…>` links. The draft is model output over
 * untrusted text; it must not ping people or link anywhere.
 */
export function slackSafeText(s: string): string {
  return s
    .replace(/<(?:[!@#]|https?:|mailto:)[^>]*>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export async function runReply(deps: AgentDeps, itemId: string): Promise<AgentOutcome> {
  const { db } = deps;
  const ctx = await loadItemContext(db, itemId);
  if (!ctx) return { status: 'missing' };
  if (ctx.item.kind !== 'email' && ctx.item.kind !== 'chat') return { status: 'unsupported_kind' };
  if (isFromMe(ctx)) return { status: 'from_me' };
  // Recipient / channel come from the DB, never from model output.
  const dest = replyTarget(ctx);
  if (!dest) return { status: 'no_recipient' };
  const readResource = ctx.item.kind === 'chat' ? 'chat' : 'email';

  const userId = ctx.account.userId;
  const accountId = ctx.account.id;
  const p = agentPrincipal(userId, 'reply');
  const target = `item:${itemId}`;
  const idempotencyKey = `reply:${itemId}`;

  for (const [resource, action] of [
    [readResource, 'read'],
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
    details: { accountId, resource: readResource, bodyIncluded: content.bodyIncluded },
  });

  const res = await deps.router.generate({
    userId,
    agent: 'reply',
    system: dest.action === 'slack.post' ? CHAT_REPLY_SYSTEM : REPLY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          referenceLines(ctx.item.receivedAt, ctx.timezone),
          fenceItem(ctx.item.kind, content.text),
        ].join('\n\n'),
      },
    ],
    maxTokens: 4096,
    effort: 'medium',
    json: true,
  });
  const out = parseModelJson(res.text, ReplyOutput);

  const who = firstNameOf(ctx.item.author, ctx.item.authorAddress);
  const subjectBase = (ctx.item.title ?? '').trim();
  let payload: Record<string, unknown>;
  let title: string;
  if (dest.action === 'slack.post') {
    const text = slackSafeText(out.body);
    if (!text) return { status: 'empty_draft' };
    payload = SlackPostPayload.parse({
      channel: dest.channel,
      text: text.slice(0, 4000),
      ...(dest.threadTs ? { threadTs: dest.threadTs } : {}),
    });
    title = dest.channelName
      ? `Reply to ${who} in #${dest.channelName}`
      : dest.channel.startsWith('D')
        ? `Reply to ${who} on Slack`
        : `Reply to ${who} in Slack`;
  } else {
    const subject = /^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`.trim();
    payload = EmailSendPayload.parse({
      to: [dest.to],
      cc: [],
      subject,
      body: out.body.trim(),
      ...(dest.threadId ? { threadId: dest.threadId } : {}),
      ...(dest.inReplyTo ? { inReplyTo: dest.inReplyTo } : {}),
    });
    const topic =
      cleanTopic(out.topic ?? '') ||
      cleanTopic(subjectBase.replace(/^((re|fwd?)\s*:\s*)+/i, '')) ||
      'your message';
    title = `Reply to ${who}: ${topic}`;
  }

  const [row] = await db
    .insert(proposals)
    .values({
      userId,
      accountId,
      agent: PRINCIPAL,
      model: res.model,
      action: dest.action,
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
      action: dest.action,
      model: res.model,
      fallbackUsed: res.fallbackUsed,
    },
  });
  await deps.publishLive(userId, { type: 'proposal.created', proposalId: row.id });
  await deps.publishLive(userId, { type: 'item.updated', itemId });
  const job: NotifierJob = {
    userId,
    kind: 'approval',
    // Never the proposal title: it names the sender and the topic.
    ...PUSH_TEXT.approval,
    data: { proposalId: row.id, itemId },
    dedupeKey: `proposal:${row.id}`,
  };
  await deps.enqueue(QUEUES.notifier, job, { jobId: jobId('notify', 'proposal', row.id) });
  return { status: 'proposed', proposalId: row.id };
}
