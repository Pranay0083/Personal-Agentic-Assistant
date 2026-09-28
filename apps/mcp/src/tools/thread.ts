import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { accounts, itemBodies, items } from '@hub/db';
import { fenceUntrusted } from '@hub/models';
import { open } from '@hub/server/secrets';
import {
  auditTool,
  errorResult,
  iso,
  loadUser,
  pausedResult,
  PolicyCache,
  resourceFor,
  text,
  type ToolEnv,
} from './common';

export const ThreadInput = { itemId: z.uuid().describe('An itemId from search_context') };

const MAX_ITEMS = 50;
const MAX_BODY_CHARS = 20_000;

export async function getThread(env: ToolEnv, args: { itemId: string }): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'get_thread', user);
  const { db } = env.ctx;

  const [item] = await db
    .select({
      id: items.id,
      accountId: items.accountId,
      kind: items.kind,
      threadId: items.threadId,
      nickname: accounts.nickname,
      provider: accounts.provider,
    })
    .from(items)
    .innerJoin(accounts, eq(accounts.id, items.accountId))
    .where(and(eq(items.id, args.itemId), eq(accounts.userId, env.principal.userId)));
  if (!item) {
    await auditTool(env, 'get_thread', { decision: 'denied', reason: 'not found' }, args.itemId);
    return errorResult('Item not found.');
  }

  const cache = new PolicyCache(env);
  const d = await cache.check(item.accountId, resourceFor(item.kind), 'read');
  if (!d.allow) {
    await auditTool(
      env,
      'get_thread',
      { decision: 'denied', reason: d.reason, accountId: item.accountId },
      item.id,
    );
    return errorResult(
      `Not allowed: the user has not given this client ${resourceFor(item.kind)} access on ` +
        `${item.nickname} (${item.provider}). Call request_access with accountId ${item.accountId} ` +
        `and resource "${resourceFor(item.kind)}" if you need it.`,
    );
  }

  const rows = await db
    .select()
    .from(items)
    .where(
      item.threadId
        ? and(eq(items.accountId, item.accountId), eq(items.threadId, item.threadId))
        : eq(items.id, item.id),
    )
    .orderBy(asc(items.receivedAt))
    .limit(MAX_ITEMS);

  // A thread lives in one account, but check each kind it contains.
  const visible = [];
  for (const r of rows) {
    if ((await cache.check(r.accountId, resourceFor(r.kind), 'read')).allow) visible.push(r);
  }

  // Cloud models see summaries only when the user keeps bodies local.
  const includeBodies = user.settings.keepBodiesLocal !== true;
  const bodies = new Map<string, string>();
  if (includeBodies) {
    const refs = visible.map((r) => r.bodyRef).filter((x): x is string => !!x);
    if (refs.length) {
      const sealed = await db
        .select()
        .from(itemBodies)
        .where(and(inArray(itemBodies.id, refs), eq(itemBodies.accountId, item.accountId)));
      const now = env.ctx.now();
      for (const b of sealed) {
        if (b.expiresAt && b.expiresAt <= now) continue;
        const plain = (await open(env.ctx.secrets, b)).toString('utf8');
        bodies.set(
          b.id,
          plain.length > MAX_BODY_CHARS ? `${plain.slice(0, MAX_BODY_CHARS)}…` : plain,
        );
      }
    }
  }

  await auditTool(
    env,
    'get_thread',
    {
      decision: 'allowed',
      accountId: item.accountId,
      itemIds: visible.map((r) => r.id),
      bodiesIncluded: bodies.size,
      keepBodiesLocal: !includeBodies,
    },
    item.id,
  );

  const thread = visible.map((r) => ({
    itemId: r.id,
    kind: r.kind,
    author: r.author,
    authorAddress: r.authorAddress,
    title: r.title,
    summary: r.summary,
    receivedAt: iso(r.receivedAt),
    url: r.url,
    body: r.bodyRef ? (bodies.get(r.bodyRef) ?? null) : null,
  }));
  const header =
    `Thread in ${item.nickname} (${item.provider}), ${thread.length} item${thread.length === 1 ? '' : 's'}.` +
    (includeBodies ? '' : ' The user keeps full bodies local, so only summaries are shown.');
  return text(`${header}\n\n${fenceUntrusted(JSON.stringify(thread, null, 2), 'thread')}`);
}
