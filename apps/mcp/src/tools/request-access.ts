import { and, count, eq, isNull } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { accessRequests, accounts } from '@hub/db';
import { providerHolds } from '@hub/policy';
import { DataResource, Provider } from '@hub/shared';
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

export const RequestAccessInput = {
  provider: Provider.optional().describe('Ask for every account of this provider'),
  accountId: z.uuid().optional().describe('Ask for one account (preferred)'),
  resource: DataResource.describe('Data to read, e.g. email'),
  reason: z.string().trim().min(1).max(500).describe('Why you need it, shown to the user'),
  durationMinutes: z.number().int().min(5).max(240).default(60),
};
type RequestArgs = {
  provider?: Provider;
  accountId?: string;
  resource: DataResource;
  reason: string;
  durationMinutes: number;
};

const MAX_PENDING = 5;

export async function requestAccess(env: ToolEnv, args: RequestArgs): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'request_access', user);
  const { db } = env.ctx;
  const deny = async (reason: string, message: string) => {
    await auditTool(env, 'request_access', {
      decision: 'denied',
      reason,
      accountId: args.accountId ?? null,
      provider: args.provider ?? null,
      resource: args.resource,
    });
    return errorResult(message);
  };

  if (!args.accountId && !args.provider) {
    return deny('no scope', 'Give an accountId (preferred) or a provider.');
  }
  let provider: string | undefined = args.provider;
  let label: string = args.provider ?? '';
  if (args.accountId) {
    const [a] = await db
      .select({ provider: accounts.provider, nickname: accounts.nickname })
      .from(accounts)
      .where(and(eq(accounts.id, args.accountId), eq(accounts.userId, env.principal.userId)));
    if (!a) return deny('account not found', 'No such account.');
    if (args.provider && args.provider !== a.provider) {
      return deny('provider mismatch', `That account is ${a.provider}, not ${args.provider}.`);
    }
    provider = a.provider;
    label = `${a.nickname} (${a.provider})`;
    const d = await new PolicyCache(env).check(args.accountId, args.resource, 'read');
    if (d.allow) {
      await auditTool(env, 'request_access', {
        decision: 'already_allowed',
        accountId: args.accountId,
        resource: args.resource,
      });
      return text(`You can already read ${args.resource} on ${label}. No request needed.`);
    }
  }
  if (provider && !providerHolds(provider, args.resource)) {
    return deny('resource not held', `${provider} has no ${args.resource}.`);
  }

  const principal = env.key;
  const scope = and(
    eq(accessRequests.userId, env.principal.userId),
    eq(accessRequests.principal, principal),
    eq(accessRequests.kind, 'access'),
    eq(accessRequests.status, 'pending'),
  );
  const [existing] = await db
    .select({ id: accessRequests.id })
    .from(accessRequests)
    .where(
      and(
        scope,
        eq(accessRequests.resource, args.resource),
        args.accountId
          ? eq(accessRequests.accountId, args.accountId)
          : isNull(accessRequests.accountId),
        provider ? eq(accessRequests.provider, provider) : isNull(accessRequests.provider),
      ),
    );
  if (existing) {
    await auditTool(
      env,
      'request_access',
      { decision: 'duplicate', requestId: existing.id },
      existing.id,
    );
    return text(
      `A request for this is already waiting on the user's phone (requestId ${existing.id}). ` +
        'Try again after they respond.',
    );
  }
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(accessRequests).where(scope);
  if (n >= MAX_PENDING) {
    return deny('too many pending', 'Too many access requests are already waiting for the user.');
  }

  const [row] = await db
    .insert(accessRequests)
    .values({
      userId: env.principal.userId,
      kind: 'access',
      principal,
      clientName: env.clientName,
      accountId: args.accountId ?? null,
      provider: provider ?? null,
      resource: args.resource,
      level: 'read',
      reason: args.reason,
      durationMinutes: args.durationMinutes,
    })
    .returning({ id: accessRequests.id });
  const id = row!.id;
  await auditTool(
    env,
    'request_access',
    {
      decision: 'requested',
      requestId: id,
      accountId: args.accountId ?? null,
      provider: provider ?? null,
      resource: args.resource,
      durationMinutes: args.durationMinutes,
    },
    id,
  );
  const job: NotifierJob = {
    userId: env.principal.userId,
    kind: 'access_request',
    title: `${env.clientName} is asking for access`,
    body: `Read ${args.resource} on ${label} for ${args.durationMinutes} min. Review it in Approvals.`,
    data: { requestId: id },
    dedupeKey: `access_request:${id}`,
  };
  await env.ctx.enqueue(QUEUES.notifier, job, { jobId: `access_request-${id}` });
  await env.ctx.publishLive(env.principal.userId, {
    type: 'access_request.created',
    requestId: id,
  });
  return text(
    `Asked the user on their phone (requestId ${id}). If they allow it, read access to ` +
      `${args.resource} on ${label} lasts ${args.durationMinutes} minutes; retry your call then.`,
  );
}
