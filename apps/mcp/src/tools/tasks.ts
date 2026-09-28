import { and, desc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { accounts, items, tasks } from '@hub/db';
import { fenceUntrusted } from '@hub/models';
import { ItemKind, TaskStatus } from '@hub/shared';
import { auditWithheld, readableKinds, withheldNote } from './access';
import {
  auditTool,
  iso,
  likeTerm,
  loadUser,
  pausedResult,
  PolicyCache,
  PROVIDER_PRIMARY,
  resourceFor,
  text,
  userAccounts,
  type ToolEnv,
} from './common';

export const TasksInput = {
  status: TaskStatus.default('open').describe('open (default), done or dismissed'),
  project: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
};

export const ProjectInput = {
  project: z.string().trim().min(1).max(200).describe('Project name as used on tasks'),
};

type TaskFilter = { status?: string[]; project?: string; limit: number; doneSince?: Date };

/**
 * Tasks whose source account the client can read. Tasks with no account are shown only if
 * the user wrote them; orphaned agent tasks are withheld.
 */
async function readableTasks(env: ToolEnv, cache: PolicyCache, f: TaskFilter) {
  const conds: SQL[] = [eq(tasks.userId, env.principal.userId)];
  if (f.status) conds.push(inArray(tasks.status, f.status));
  if (f.project) conds.push(sql`lower(${tasks.project}) = lower(${f.project})`);
  if (f.doneSince) {
    conds.push(
      or(
        eq(tasks.status, 'open'),
        gt(tasks.completedAt, f.doneSince),
        gt(tasks.updatedAt, f.doneSince),
      ) as SQL,
    );
  }
  const rows = await env.ctx.db
    .select({
      id: tasks.id,
      title: tasks.title,
      notes: tasks.notes,
      dueAt: tasks.dueAt,
      status: tasks.status,
      project: tasks.project,
      accountId: tasks.accountId,
      sourceItemId: tasks.sourceItemId,
      createdBy: tasks.createdBy,
      createdAt: tasks.createdAt,
      provider: accounts.provider,
      nickname: accounts.nickname,
      itemKind: items.kind,
      itemAccountId: items.accountId,
    })
    .from(tasks)
    .leftJoin(accounts, eq(accounts.id, tasks.accountId))
    .leftJoin(items, eq(items.id, tasks.sourceItemId))
    .where(and(...conds))
    .orderBy(sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt))
    .limit(Math.min(f.limit * 3, 300));

  const visible: typeof rows = [];
  let withheld = 0;
  for (const t of rows) {
    // An agent-created task whose account was deleted (account_id and source_item_id set
    // NULL) can no longer be checked against its source's policy, so withhold it. Only
    // tasks the user wrote themselves are account-free by nature.
    if (!t.accountId && t.createdBy.startsWith('agent:')) {
      withheld++;
      continue;
    }
    const checks: [string, string][] = [];
    if (t.accountId) {
      const resource = t.itemKind ? resourceFor(t.itemKind) : PROVIDER_PRIMARY[t.provider ?? ''];
      if (!resource) {
        withheld++;
        continue;
      }
      checks.push([t.accountId, resource]);
    }
    if (t.itemAccountId && t.itemKind && t.itemAccountId !== t.accountId) {
      checks.push([t.itemAccountId, resourceFor(t.itemKind)]);
    }
    let ok = true;
    for (const [a, r] of checks) {
      if (!(await cache.check(a, r, 'read')).allow) ok = false;
    }
    if (ok) visible.push(t);
    else withheld++;
    if (visible.length >= f.limit) break;
  }
  return { visible, withheld };
}

function taskView(t: Awaited<ReturnType<typeof readableTasks>>['visible'][number]) {
  return {
    taskId: t.id,
    title: t.title,
    notes: t.notes,
    dueAt: iso(t.dueAt),
    status: t.status,
    project: t.project,
    source: t.accountId ? `${t.nickname} (${t.provider})` : 'added by the user',
    accountId: t.accountId,
    sourceItemId: t.sourceItemId,
    createdBy: t.createdBy,
  };
}

export async function getMyTasks(
  env: ToolEnv,
  args: { status: string; project?: string; limit: number },
): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'get_my_tasks', user);
  const { visible, withheld } = await readableTasks(env, new PolicyCache(env), {
    status: [args.status],
    project: args.project,
    limit: args.limit,
  });
  await auditTool(env, 'get_my_tasks', {
    decision: withheld && !visible.length ? 'denied' : withheld ? 'partial' : 'allowed',
    taskIds: visible.map((t) => t.id),
    withheldCount: withheld,
  });
  const parts = [`${visible.length} ${args.status} task${visible.length === 1 ? '' : 's'}.`];
  if (withheld) {
    parts.push(
      `${withheld} more come from sources this client is not allowed to read; use request_access to ask for them.`,
    );
  }
  if (visible.length) {
    parts.push(fenceUntrusted(JSON.stringify(visible.map(taskView), null, 2), 'tasks'));
  }
  return text(parts.join('\n\n'));
}

export async function getProjectStatus(
  env: ToolEnv,
  args: { project: string },
): Promise<CallToolResult> {
  const user = await loadUser(env);
  if (!user || user.paused) return pausedResult(env, 'get_project_status', user);
  const cache = new PolicyCache(env);
  const now = env.ctx.now();
  const since = new Date(now.getTime() - 14 * 24 * 3600_000);
  const { visible, withheld: withheldTasks } = await readableTasks(env, cache, {
    project: args.project,
    limit: 100,
    doneSince: since,
  });

  const readable = await readableKinds(cache, await userAccounts(env), ItemKind.options);
  let related: {
    id: string;
    kind: string;
    nickname: string;
    provider: string;
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
    const like = likeTerm(args.project);
    related = await env.ctx.db
      .select({
        id: items.id,
        kind: items.kind,
        nickname: accounts.nickname,
        provider: accounts.provider,
        title: items.title,
        summary: items.summary,
        receivedAt: items.receivedAt,
        url: items.url,
      })
      .from(items)
      .innerJoin(accounts, eq(accounts.id, items.accountId))
      .where(
        and(
          eq(accounts.userId, env.principal.userId),
          scope,
          gt(items.receivedAt, new Date(now.getTime() - 30 * 24 * 3600_000)),
          or(ilike(items.title, like), ilike(items.summary, like)) as SQL,
        ),
      )
      .orderBy(desc(items.receivedAt))
      .limit(10);
  }

  await auditTool(env, 'get_project_status', {
    decision: 'allowed',
    taskIds: visible.map((t) => t.id),
    itemIds: related.map((r) => r.id),
    withheldTaskCount: withheldTasks,
    withheld: auditWithheld(readable.withheld),
  });

  const open = visible.filter((t) => t.status === 'open');
  const overdue = open.filter((t) => t.dueAt && t.dueAt < now).length;
  const done = visible.filter((t) => t.status === 'done').length;
  const parts = [
    `Project: ${open.length} open task${open.length === 1 ? '' : 's'} (${overdue} overdue), ` +
      `${done} done in the last 14 days, ${related.length} related recent item${related.length === 1 ? '' : 's'}.`,
  ];
  if (withheldTasks)
    parts.push(`${withheldTasks} task(s) come from sources this client cannot read.`);
  const note = withheldNote(readable.withheld);
  if (note) parts.push(note);
  const data = {
    tasks: visible.map(taskView),
    relatedItems: related.map((r) => ({
      itemId: r.id,
      kind: r.kind,
      account: r.nickname,
      provider: r.provider,
      title: r.title,
      summary: r.summary,
      receivedAt: iso(r.receivedAt),
      url: r.url,
    })),
  };
  parts.push(fenceUntrusted(JSON.stringify(data, null, 2), 'project status'));
  return text(parts.join('\n\n'));
}
