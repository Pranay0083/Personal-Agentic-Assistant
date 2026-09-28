import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { accounts, items, proposals } from '@hub/db';
import { GmailSendPayload, ProposalAction } from '@hub/shared';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import {
  auditTool,
  errorResult,
  loadUser,
  pausedResult,
  PolicyCache,
  text,
  type ToolEnv,
} from './common';

export const ProposeInput = {
  accountId: z.uuid().describe('Account to act from, e.g. the Gmail account that will send'),
  action: ProposalAction.describe('gmail.send is supported today'),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      'For gmail.send: { to: string[], cc?: string[], subject, body, inReplyTo?, threadId? }',
    ),
  reason: z.string().trim().min(1).max(500).describe('Why, shown to the user'),
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .optional()
    .describe('Reuse the same key when retrying so only one proposal is created'),
  sourceItemId: z.uuid().optional().describe('Item this responds to, if any'),
};
type ProposeArgs = {
  accountId: string;
  action: ProposalAction;
  payload: Record<string, unknown>;
  reason: string;
  idempotencyKey?: string;
  sourceItemId?: string;
};

/** Policy resource and provider behind each executor action. */
const ACTIONS: Record<
  ProposalAction,
  { resource: string; provider: string; schema?: z.ZodType<Record<string, unknown>> }
> = {
  'gmail.send': { resource: 'message.send', provider: 'gmail', schema: GmailSendPayload },
  'gmail.label': { resource: 'email.label', provider: 'gmail' },
  'jira.transition': { resource: 'ticket.update', provider: 'atlassian' },
  'slack.post': { resource: 'message.send', provider: 'slack' },
};

/** Stable JSON: object keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function titleFor(action: ProposalAction, payload: Record<string, unknown>): string {
  if (action === 'gmail.send') {
    const p = payload as GmailSendPayload;
    return `Email ${p.to.join(', ')}: ${p.subject || '(no subject)'}`.slice(0, 140);
  }
  return action;
}

export async function proposeAction(env: ToolEnv, args: ProposeArgs): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'propose_action', user);
  const { db } = env.ctx;
  const deny = async (reason: string, message: string) => {
    await auditTool(env, 'propose_action', {
      decision: 'denied',
      reason,
      accountId: args.accountId,
      action: args.action,
    });
    return errorResult(message);
  };

  const spec = ACTIONS[args.action];
  const cache = new PolicyCache(env);
  const draft = await cache.check(args.accountId, 'draft.write', 'write');
  const act = await cache.check(args.accountId, spec.resource, 'draft');
  if (!draft.allow || !act.allow) {
    const reason = !draft.allow ? draft.reason : act.reason;
    return deny(
      reason,
      `Not allowed: this client may not propose ${args.action} from that account (${reason}). ` +
        'The user controls this on the Permissions screen.',
    );
  }
  const [account] = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(and(eq(accounts.id, args.accountId), eq(accounts.userId, env.principal.userId)));
  if (!account) return deny('account not found', 'No such account.');
  if (account.provider !== spec.provider) {
    return deny('wrong provider', `${args.action} needs a ${spec.provider} account.`);
  }
  if (!spec.schema) {
    return deny('unsupported action', `${args.action} proposals are not supported yet.`);
  }
  const parsed = spec.schema.safeParse(args.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`);
    return deny('invalid payload', `Invalid payload for ${args.action}:\n${issues.join('\n')}`);
  }
  const payload = parsed.data;

  if (args.sourceItemId) {
    const [src] = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.id, args.sourceItemId), eq(items.accountId, args.accountId)));
    if (!src) return deny('source item not found', 'sourceItemId is not an item of that account.');
  }

  const clientId = env.principal.clientId;
  const idempotencyKey = args.idempotencyKey
    ? `mcp:${clientId}:${args.idempotencyKey}`
    : `mcp:${clientId}:${createHash('sha256')
        .update(
          canonicalJson({
            client: clientId,
            action: args.action,
            accountId: args.accountId,
            payload,
          }),
        )
        .digest('hex')}`;

  const [inserted] = await db
    .insert(proposals)
    .values({
      userId: env.principal.userId,
      accountId: args.accountId,
      agent: env.key,
      action: args.action,
      title: titleFor(args.action, payload),
      payload,
      status: 'pending',
      sourceItemId: args.sourceItemId ?? null,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: proposals.idempotencyKey })
    .returning({ id: proposals.id, status: proposals.status });
  const proposal =
    inserted ??
    (
      await db
        .select({ id: proposals.id, status: proposals.status })
        .from(proposals)
        .where(
          and(
            eq(proposals.idempotencyKey, idempotencyKey),
            eq(proposals.userId, env.principal.userId),
          ),
        )
    )[0];
  if (!proposal) return deny('idempotency conflict', 'Could not create the proposal.');

  await auditTool(
    env,
    'propose_action',
    {
      decision: inserted ? 'created' : 'duplicate',
      proposalId: proposal.id,
      accountId: args.accountId,
      action: args.action,
    },
    proposal.id,
  );
  if (inserted) {
    const job: NotifierJob = {
      userId: env.principal.userId,
      kind: 'approval',
      title: 'Approval needed',
      body: `${env.clientName} drafted ${args.action === 'gmail.send' ? 'an email' : 'an action'} for you to review.`,
      data: { proposalId: proposal.id },
      dedupeKey: `approval:${proposal.id}`,
    };
    await env.ctx.enqueue(QUEUES.notifier, job, { jobId: `approval-${proposal.id}` });
    await env.ctx.publishLive(env.principal.userId, {
      type: 'proposal.created',
      proposalId: proposal.id,
    });
  }
  const status =
    proposal.status === 'pending'
      ? 'It is waiting for the user to approve, edit or reject it on their phone. Nothing has been sent.'
      : `Its current status is ${proposal.status}.`;
  return text(
    `${inserted ? 'Proposal created' : 'This proposal already exists'} (proposalId ${proposal.id}). ${status} ` +
      'This server never executes actions itself.',
  );
}
