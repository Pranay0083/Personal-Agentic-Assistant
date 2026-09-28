import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { grants, mcpClients } from '@hub/db';
import type { Ctx } from '../context';
import { iso, idParam, notFound } from '../http';

export function mcpRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  app.get('/mcp', async (req) => {
    const clients = await db
      .select()
      .from(mcpClients)
      .where(and(eq(mcpClients.userId, req.auth.userId), isNull(mcpClients.revokedAt)))
      .orderBy(desc(mcpClients.createdAt));
    const url = config.publicMcpUrl;
    return {
      url,
      command: `claude mcp add --transport http hub ${url}`,
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        lastUsedAt: iso(c.lastUsedAt),
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  app.delete('/mcp/clients/:id', async (req, reply) => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const now = ctx.now();
    const [client] = await db
      .select()
      .from(mcpClients)
      .where(and(eq(mcpClients.id, id), eq(mcpClients.userId, userId)));
    if (!client) throw notFound('MCP client');
    if (!client.revokedAt) {
      await db.update(mcpClients).set({ revokedAt: now }).where(eq(mcpClients.id, id));
      // A revoked client keeps no temporary access either.
      await db
        .update(grants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(grants.userId, userId),
            eq(grants.principal, `mcp:${id}`),
            isNull(grants.revokedAt),
          ),
        );
      await ctx.audit({
        userId,
        principal: 'user',
        action: 'mcp_client.revoked',
        target: `mcp:${id}`,
      });
    }
    return reply.code(204).send();
  });
}
