import { and, count, desc, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accounts, briefs, items, proposals, tasks } from '@hub/db';
import type { TodayRes } from '@hub/shared/api';
import type { Ctx } from '../context';
import { iso, localDate } from '../http';
import { toBrief, toItem } from '../serialize';
import { selectTasks } from './tasks';

export function todayRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/today', async (req): Promise<TodayRes> => {
    const userId = req.auth.userId;
    const user = await ctx.user(userId);
    const date = localDate(ctx.now(), user.timezone);

    const [brief] = await db
      .select()
      .from(briefs)
      .where(and(eq(briefs.userId, userId), eq(briefs.date, date)));

    const needsYou = await db
      .select({ item: items })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(eq(accounts.userId, userId), eq(items.bucket, 'needs_you')))
      .orderBy(desc(items.receivedAt), desc(items.id))
      .limit(3);

    const nextUp = await selectTasks(db, userId, [eq(tasks.status, 'open')], { limit: 5 });

    const [open] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.status, 'open')));
    const [pending] = await db
      .select({ n: count() })
      .from(proposals)
      .where(and(eq(proposals.userId, userId), eq(proposals.status, 'pending')));
    const [synced] = await db
      .select({ at: max(accounts.lastSyncedAt) })
      .from(accounts)
      .where(eq(accounts.userId, userId));

    return {
      brief: brief ? toBrief(brief) : null,
      needsYou: needsYou.map((r) => toItem(r.item)),
      nextUp,
      openTaskCount: open?.n ?? 0,
      pendingApprovals: pending?.n ?? 0,
      lastSyncedAt: iso(synced?.at ?? null),
    };
  });
}
