import { eq } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { accounts, audit, users } from '@hub/db';
import { can, type Decision, type Principal } from '@hub/policy';
import type { ItemKind, PolicyAction } from '@hub/shared';
import type { Ctx } from '../deps';

export type McpPrincipal = Extract<Principal, { kind: 'mcp' }>;

export type ToolEnv = {
  ctx: Ctx;
  principal: McpPrincipal;
  /** `mcp:<mcp_clients.id>`, the policy and audit key. */
  key: string;
  clientName: string;
};

/** Item kind → policy data resource. */
export const KIND_RESOURCE: Record<ItemKind, string> = {
  email: 'email',
  chat: 'chat',
  ticket: 'tickets',
  note: 'notes',
  event: 'calendar',
  file: 'files',
  code: 'code',
};

export function resourceFor(kind: string): string {
  return KIND_RESOURCE[kind as ItemKind] ?? kind;
}

/** Main data resource of a provider, for tasks that have an account but no source item. */
export const PROVIDER_PRIMARY: Record<string, string> = {
  gmail: 'email',
  microsoft: 'email',
  slack: 'chat',
  atlassian: 'tickets',
  notion: 'notes',
  github: 'code',
};

/** Memoizes `can()` for the duration of one tool call. */
export class PolicyCache {
  private readonly memo = new Map<string, Promise<Decision>>();
  constructor(private readonly env: ToolEnv) {}
  check(accountId: string, resource: string, action: PolicyAction = 'read'): Promise<Decision> {
    const k = `${accountId}|${resource}|${action}`;
    let d = this.memo.get(k);
    if (!d) {
      d = can(this.env.ctx.db, this.env.principal, accountId, resource, action);
      this.memo.set(k, d);
    }
    return d;
  }
}

export type AccountRow = {
  id: string;
  provider: string;
  nickname: string;
  isPersonal: boolean;
};

export async function userAccounts(env: ToolEnv): Promise<AccountRow[]> {
  return env.ctx.db
    .select({
      id: accounts.id,
      provider: accounts.provider,
      nickname: accounts.nickname,
      isPersonal: accounts.isPersonal,
    })
    .from(accounts)
    .where(eq(accounts.userId, env.principal.userId));
}

export type UserRow = { id: string; paused: boolean; settings: Record<string, unknown> };

/**
 * Loads the user. Paused users get every tool denied; `can()` denies as well, this
 * covers tools whose results (the user's own tasks) have no account to check.
 */
export async function loadUser(env: ToolEnv): Promise<UserRow | null> {
  const [u] = await env.ctx.db
    .select({ id: users.id, paused: users.paused, settings: users.settings })
    .from(users)
    .where(eq(users.id, env.principal.userId));
  return u ? { ...u, settings: (u.settings ?? {}) as Record<string, unknown> } : null;
}

export async function auditTool(
  env: ToolEnv,
  action: string,
  details: Record<string, unknown>,
  target: string | null = null,
) {
  await audit(env.ctx.db, {
    userId: env.principal.userId,
    principal: env.key,
    action: `mcp.${action}`,
    target,
    details,
  });
}

export function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

export function errorResult(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }], isError: true };
}

/** Standard denial for a paused or missing user. Audited. */
export async function pausedResult(env: ToolEnv, tool: string, user: UserRow | null) {
  await auditTool(env, tool, { decision: 'denied', reason: user ? 'paused' : 'user not found' });
  return errorResult(
    user
      ? 'Hub is paused by its owner. All agent and MCP access is off until they resume it on their phone.'
      : 'This Hub account no longer exists.',
  );
}

/** Escapes LIKE wildcards so a query is matched literally. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
