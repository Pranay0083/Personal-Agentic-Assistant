import { and, asc, count, eq, gt, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accounts, events, grants, mcpClients, users } from '@hub/db';
import type { Provider } from '@hub/shared';
import type { ControlRes } from '@hub/shared/api';
import type { Ctx } from '../context';
import { iso } from '../http';

/** triage, extractor, brief, reply. */
const AGENT_COUNT = 4;

export function controlRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  async function control(userId: string): Promise<ControlRes> {
    const user = await ctx.user(userId);
    const accts = await db
      .select({
        id: accounts.id,
        nickname: accounts.nickname,
        provider: accounts.provider,
        status: accounts.status,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(asc(accounts.createdAt));
    const [lastEvent] = await db
      .select({ at: max(events.createdAt) })
      .from(events)
      .innerJoin(accounts, eq(accounts.id, events.accountId))
      .where(eq(accounts.userId, userId));
    const [activeGrants] = await db
      .select({ n: count() })
      .from(grants)
      .where(
        and(eq(grants.userId, userId), isNull(grants.revokedAt), gt(grants.expiresAt, ctx.now())),
      );
    const clients = await db
      .select({ name: mcpClients.name })
      .from(mcpClients)
      .where(and(eq(mcpClients.userId, userId), isNull(mcpClients.revokedAt)))
      .orderBy(asc(mcpClients.createdAt));
    return {
      paused: user.paused,
      activeAgents: user.paused ? 0 : AGENT_COUNT,
      lastEventAt: iso(lastEvent?.at ?? null),
      accountsCount: accts.length,
      accountsNeedingAttention: accts
        .filter((a) => a.status === 'reconnect')
        .map((a) => ({ id: a.id, nickname: a.nickname, provider: a.provider as Provider })),
      temporaryGrants: activeGrants?.n ?? 0,
      connectedClients: clients.map((c) => c.name),
    };
  }

  async function setPaused(userId: string, paused: boolean) {
    await db.update(users).set({ paused }).where(eq(users.id, userId));
    await ctx.audit({
      userId,
      principal: 'user',
      action: paused ? 'control.paused' : 'control.resumed',
    });
    await ctx.live(userId, { type: 'control.changed', paused });
    return control(userId);
  }

  app.get('/control', async (req) => control(req.auth.userId));
  app.post('/control/pause', async (req) => setPaused(req.auth.userId, true));
  app.post('/control/resume', async (req) => setPaused(req.auth.userId, false));
}
