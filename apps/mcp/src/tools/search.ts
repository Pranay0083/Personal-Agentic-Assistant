import { and, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { accounts, items } from '@hub/db';
import { fenceUntrusted } from '@hub/models';
import { ItemKind } from '@hub/shared';
import { auditWithheld, readableKinds, withheldNote } from './access';
import {
  auditTool,
  errorResult,
  iso,
  likeTerm,
  loadUser,
  pausedResult,
  PolicyCache,
  text,
  userAccounts,
  type ToolEnv,
} from './common';

export const SearchInput = {
  query: z.string().trim().min(1).max(500).describe('Words to look for in titles and summaries'),
  kinds: z.array(ItemKind).max(7).optional().describe('Limit to these item kinds'),
  accountId: z.uuid().optional().describe('Limit to one connected account'),
  limit: z.number().int().min(1).max(50).default(10),
};
type SearchArgs = { query: string; kinds?: ItemKind[]; accountId?: string; limit: number };

export async function searchContext(env: ToolEnv, args: SearchArgs): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'search_context', user);

  let accts = await userAccounts(env);
  if (args.accountId) {
    accts = accts.filter((a) => a.id === args.accountId);
    if (!accts.length) {
      await auditTool(env, 'search_context', {
        decision: 'denied',
        reason: 'account not found',
        accountId: args.accountId,
      });
      return errorResult('No such account.');
    }
  }
  const kinds = args.kinds?.length ? args.kinds : ItemKind.options;
  const readable = await readableKinds(new PolicyCache(env), accts, kinds);
  if (readable.paused) return pausedResult(env, 'search_context', { ...user, paused: true });

  const terms = args.query.split(/\s+/).filter(Boolean).slice(0, 8);
  let rows: {
    id: string;
    kind: string;
    accountId: string;
    nickname: string;
    provider: string;
    author: string | null;
    title: string | null;
    summary: string | null;
    receivedAt: Date;
    url: string | null;
  }[] = [];
  if (readable.kinds.size) {
    const scope = or(
      ...[...readable.kinds].map(([acct, ks]) =>
        and(eq(items.accountId, acct), inArray(items.kind, ks)),
      ),
    ) as SQL;
    const match = terms.map(
      (t) =>
        or(
          ilike(items.title, likeTerm(t)),
          ilike(items.summary, likeTerm(t)),
          ilike(items.author, likeTerm(t)),
        ) as SQL,
    );
    rows = await env.ctx.db
      .select({
        id: items.id,
        kind: items.kind,
        accountId: items.accountId,
        nickname: accounts.nickname,
        provider: accounts.provider,
        author: items.author,
        title: items.title,
        summary: items.summary,
        receivedAt: items.receivedAt,
        url: items.url,
      })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(and(eq(accounts.userId, env.principal.userId), scope, ...match))
      .orderBy(desc(items.receivedAt))
      .limit(args.limit);
  }

  await auditTool(env, 'search_context', {
    decision: readable.kinds.size ? (readable.withheld.length ? 'partial' : 'allowed') : 'denied',
    searchedAccounts: [...readable.kinds.keys()],
    withheld: auditWithheld(readable.withheld),
    itemIds: rows.map((r) => r.id),
    queryTerms: terms.length,
  });

  const parts: string[] = [];
  if (!readable.kinds.size) {
    parts.push('Nothing was searched: no source you asked for is readable by this client.');
  } else {
    parts.push(`Found ${rows.length} item${rows.length === 1 ? '' : 's'}.`);
  }
  const note = withheldNote(readable.withheld);
  if (note) parts.push(note);
  if (rows.length) {
    const results = rows.map((r) => ({
      itemId: r.id,
      kind: r.kind,
      account: r.nickname,
      accountId: r.accountId,
      provider: r.provider,
      author: r.author,
      title: r.title,
      summary: r.summary,
      receivedAt: iso(r.receivedAt),
      url: r.url,
    }));
    parts.push(fenceUntrusted(JSON.stringify(results, null, 2), 'search results'));
    parts.push('Use get_thread with an itemId for the full conversation.');
  }
  return text(parts.join('\n\n'));
}
