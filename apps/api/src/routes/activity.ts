import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { auditLog } from '@hub/db';
import { z } from 'zod';
import type { Ctx } from '../context';
import { parse } from '../http';

const Query = z.object({
  cursor: z.string().regex(/^\d+$/, 'cursor: invalid').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function activityRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/activity', async (req) => {
    const q = parse(Query, req.query);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, req.auth.userId),
          ...(q.cursor ? [lt(auditLog.id, Number(q.cursor))] : []),
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({
        id: String(r.id),
        principal: r.principal,
        action: r.action,
        target: r.target,
        details: (r.details ?? null) as Record<string, unknown> | null,
        at: r.at.toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? String(last.id) : null,
    };
  });
}
