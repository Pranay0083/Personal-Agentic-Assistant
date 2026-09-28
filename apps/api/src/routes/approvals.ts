import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accessRequests, grants, proposals } from '@hub/db';
import {
  AccessRequest as AccessRequestSchema,
  GmailSendPayload,
  PolicyLevel,
  ProposalStatus,
  type Grant,
  type Proposal,
} from '@hub/shared';
import { AllowAccessReq, ApproveProposalReq } from '@hub/shared/api';
import { QUEUES } from '@hub/shared/queues';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, conflict, HttpError, idParam, notFound, parse } from '../http';
import { toAccessRequest, toGrant, toProposal } from '../serialize';

/** Schemas an edited payload must satisfy, per action. Actions without one can't be edited. */
const PAYLOAD_SCHEMAS: Partial<Record<Proposal['action'], ZodType>> = {
  'gmail.send': GmailSendPayload,
};

const StatusQuery = z.object({ status: ProposalStatus.optional() });
const RequestStatusQuery = z.object({ status: AccessRequestSchema.shape.status.optional() });

/** BullMQ custom ids may not contain a single ':' (only the legacy 3-part form). */
export const executorJobId = (proposalId: string) => `exec-${proposalId}`;

export function approvalRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/proposals', async (req): Promise<{ proposals: Proposal[] }> => {
    const q = parse(StatusQuery, req.query);
    const rows = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.userId, req.auth.userId),
          ...(q.status ? [eq(proposals.status, q.status)] : []),
        ),
      )
      .orderBy(desc(proposals.createdAt), desc(proposals.id))
      .limit(200);
    return { proposals: rows.map(toProposal) };
  });

  app.post('/proposals/:id/approve', async (req): Promise<Proposal> => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const body = parse(ApproveProposalReq, req.body);
    const [current] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.userId, userId)));
    if (!current) throw notFound('proposal');
    if (current.status !== 'pending')
      throw conflict('not_pending', `proposal is ${current.status}`);

    let payload: Record<string, unknown> | undefined;
    if (body.payload) {
      const schema = PAYLOAD_SCHEMAS[current.action as Proposal['action']];
      if (!schema) throw badRequest(`${current.action} proposals can't be edited`);
      payload = schema.parse(body.payload) as Record<string, unknown>;
    }

    // Conditional update: only one approve can move it out of `pending`.
    const now = ctx.now();
    const [approved] = await db
      .update(proposals)
      .set({ status: 'approved', decidedAt: now, ...(payload ? { payload } : {}) })
      .where(
        and(eq(proposals.id, id), eq(proposals.userId, userId), eq(proposals.status, 'pending')),
      )
      .returning();
    if (!approved) throw conflict('not_pending', 'proposal was already decided');

    await ctx.audit({
      userId,
      principal: 'user',
      action: 'proposal.approved',
      target: `proposal:${id}`,
      details: {
        action: approved.action,
        accountId: approved.accountId,
        edited: payload !== undefined,
      },
    });
    // The API never performs the write; the executor re-checks policy and executes.
    try {
      await ctx.enqueue(QUEUES.executor, { proposalId: id }, { jobId: executorJobId(id) });
    } catch (err) {
      ctx.warn('executor enqueue failed', { proposalId: id, err: (err as Error).message });
      throw new HttpError(
        503,
        'queue_unavailable',
        'approved, but the executor could not be reached',
      );
    }
    await ctx.live(userId, { type: 'proposal.updated', proposalId: id });
    return toProposal(approved);
  });

  app.post('/proposals/:id/reject', async (req): Promise<Proposal> => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const [rejected] = await db
      .update(proposals)
      .set({ status: 'rejected', decidedAt: ctx.now() })
      .where(
        and(eq(proposals.id, id), eq(proposals.userId, userId), eq(proposals.status, 'pending')),
      )
      .returning();
    if (!rejected) {
      const [exists] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(and(eq(proposals.id, id), eq(proposals.userId, userId)));
      if (!exists) throw notFound('proposal');
      throw conflict('not_pending', `proposal is ${exists.status}`);
    }
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'proposal.rejected',
      target: `proposal:${id}`,
      details: { action: rejected.action, accountId: rejected.accountId },
    });
    await ctx.live(userId, { type: 'proposal.updated', proposalId: id });
    return toProposal(rejected);
  });

  app.get('/access-requests', async (req) => {
    const q = parse(RequestStatusQuery, req.query);
    const rows = await db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.userId, req.auth.userId),
          ...(q.status ? [eq(accessRequests.status, q.status)] : []),
        ),
      )
      .orderBy(desc(accessRequests.createdAt), desc(accessRequests.id))
      .limit(200);
    return { requests: rows.map(toAccessRequest) };
  });

  app.post('/access-requests/:id/allow', async (req): Promise<{ grant: Grant | null }> => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const { durationMinutes } = parse(AllowAccessReq, req.body);
    const [request] = await db
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.id, id), eq(accessRequests.userId, userId)));
    if (!request) throw notFound('access request');
    if (request.status !== 'pending') throw conflict('not_pending', `request is ${request.status}`);

    const now = ctx.now();
    if (request.kind === 'mcp_connect') {
      // The MCP server polls this row and finishes the client's OAuth flow.
      const [done] = await db
        .update(accessRequests)
        .set({ status: 'allowed', decidedAt: now })
        .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending')))
        .returning({ id: accessRequests.id });
      if (!done) throw conflict('not_pending', 'request was already decided');
      await ctx.audit({
        userId,
        principal: 'user',
        action: 'access_request.allowed',
        target: `access_request:${id}`,
        details: { kind: request.kind, principal: request.principal },
      });
      return { grant: null };
    }

    const level = PolicyLevel.safeParse(request.level);
    if (!level.success || level.data === 'never' || level.data === 'none') {
      throw badRequest(`cannot grant level ${request.level}`);
    }

    const grant = await db.transaction(async (tx) => {
      const [done] = await tx
        .update(accessRequests)
        .set({ status: 'allowed', decidedAt: now, durationMinutes })
        .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending')))
        .returning({ id: accessRequests.id });
      if (!done) throw conflict('not_pending', 'request was already decided');
      const [g] = await tx
        .insert(grants)
        .values({
          userId,
          principal: request.principal,
          accountId: request.accountId,
          provider: request.provider,
          scope: request.resource,
          level: level.data,
          accessRequestId: request.id,
          expiresAt: new Date(now.getTime() + durationMinutes * 60_000),
          createdAt: now,
        })
        .returning();
      return g!;
    });

    await ctx.audit({
      userId,
      principal: 'user',
      action: 'access_request.allowed',
      target: `access_request:${id}`,
      details: {
        kind: request.kind,
        principal: request.principal,
        grantId: grant.id,
        resource: request.resource,
        level: grant.level,
        accountId: request.accountId,
        provider: request.provider,
        durationMinutes,
      },
    });
    return { grant: toGrant(grant) };
  });

  app.post('/access-requests/:id/deny', async (req, reply) => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const [denied] = await db
      .update(accessRequests)
      .set({ status: 'denied', decidedAt: ctx.now() })
      .where(
        and(
          eq(accessRequests.id, id),
          eq(accessRequests.userId, userId),
          eq(accessRequests.status, 'pending'),
        ),
      )
      .returning();
    if (!denied) {
      const [exists] = await db
        .select({ status: accessRequests.status })
        .from(accessRequests)
        .where(and(eq(accessRequests.id, id), eq(accessRequests.userId, userId)));
      if (!exists) throw notFound('access request');
      throw conflict('not_pending', `request is ${exists.status}`);
    }
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'access_request.denied',
      target: `access_request:${id}`,
      details: { kind: denied.kind, principal: denied.principal },
    });
    return reply.code(204).send();
  });
}
