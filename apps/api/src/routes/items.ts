import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accounts, itemBodies, items } from '@hub/db';
import { itemBodyContext, open } from '@hub/server/secrets';
import type { Item } from '@hub/shared';
import { ItemsQuery } from '@hub/shared/api';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, idParam, notFound, parse } from '../http';
import { toItem } from '../serialize';

/** Keyset cursor over (received_at desc, id desc). `r` keeps Postgres' microsecond text. */
const Cursor = z.object({ r: z.string(), i: z.uuid() });

const encodeCursor = (r: string, i: string) =>
  Buffer.from(JSON.stringify({ r, i })).toString('base64url');

function decodeCursor(c: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('cursor: invalid');
  }
}

/** Items visible to a user: every query joins accounts on user_id. */
export const ownedItems = (userId: string) => eq(accounts.userId, userId);

export function itemRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/items', async (req) => {
    const q = parse(ItemsQuery, req.query);
    const scope: SQL[] = [ownedItems(req.auth.userId)];
    if (q.accountId) scope.push(eq(items.accountId, q.accountId));
    if (q.kind) scope.push(eq(items.kind, q.kind));
    if (q.provider) scope.push(eq(accounts.provider, q.provider));

    const page: SQL[] = [...scope];
    if (q.bucket) page.push(eq(items.bucket, q.bucket));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      page.push(
        sql`(${items.receivedAt} < ${c.r}::timestamptz OR (${items.receivedAt} = ${c.r}::timestamptz AND ${items.id} < ${c.i}::uuid))`,
      );
    }

    const rows = await db
      .select({ item: items, receivedAtText: sql<string>`${items.receivedAt}::text` })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(...page))
      .orderBy(desc(items.receivedAt), desc(items.id))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows[pageRows.length - 1];

    // Counts for the Inbox tabs: same account/kind scope, ignoring bucket and cursor.
    const [counts] = await db
      .select({
        all: count(),
        needsYou: sql<number>`count(*) filter (where ${items.bucket} = 'needs_you')`.mapWith(
          Number,
        ),
      })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(...scope));

    return {
      items: pageRows.map((r) => toItem(r.item)) satisfies Item[],
      nextCursor: hasMore && last ? encodeCursor(last.receivedAtText, last.item.id) : null,
      counts: { all: counts?.all ?? 0, needsYou: counts?.needsYou ?? 0 },
    };
  });

  app.get('/items/:id', async (req) => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const [row] = await db
      .select({ item: items })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(eq(items.id, id), ownedItems(userId)));
    if (!row) throw notFound('item');

    let body: string | null = null;
    if (row.item.bodyRef) {
      const [b] = await db
        .select()
        .from(itemBodies)
        .where(
          and(eq(itemBodies.id, row.item.bodyRef), eq(itemBodies.accountId, row.item.accountId)),
        );
      if (b && (!b.expiresAt || b.expiresAt > ctx.now())) {
        body = (await open(ctx.keys, b, itemBodyContext(row.item.accountId))).toString('utf8');
      }
    }
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'item.read',
      target: `item:${id}`,
      details: { accountId: row.item.accountId, withBody: body !== null },
    });
    return { item: toItem(row.item), body };
  });
}
