import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { accounts, grants, policies, users, type Db } from '@hub/db';
import type { PolicyLevel, Preset } from '@hub/shared';
import { decide } from './decide';
import type { Decision, PolicyAction, PolicyContext, Principal } from './types';

/** Loads everything `decide` needs for one (principal, account) pair. */
export async function loadContext(
  db: Db,
  userId: string,
  accountId: string,
  now = new Date(),
): Promise<PolicyContext | null> {
  const [user] = await db
    .select({ id: users.id, preset: users.preset, paused: users.paused })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;

  const [account] = await db
    .select({ id: accounts.id, userId: accounts.userId, provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.id, accountId));

  const provider = account?.provider ?? '__none__';
  const pol = await db
    .select()
    .from(policies)
    .where(
      and(
        eq(policies.userId, userId),
        or(
          eq(policies.accountId, accountId),
          and(
            isNull(policies.accountId),
            or(eq(policies.provider, provider), isNull(policies.provider)),
          ),
        ),
      ),
    );
  const gr = await db
    .select()
    .from(grants)
    .where(and(eq(grants.userId, userId), isNull(grants.revokedAt), gt(grants.expiresAt, now)));

  return {
    user: { id: user.id, preset: user.preset as Preset, paused: user.paused },
    account: account ?? null,
    policies: pol.map((r) => ({ ...r, level: r.level as PolicyLevel })),
    grants: gr.map((g) => ({ ...g, level: g.level as PolicyLevel })),
    now,
  };
}

/**
 * The one permission check. Call before every read or write in agents, the MCP server,
 * the API (for non-user principals) and the executor.
 */
export async function can(
  db: Db,
  p: Principal,
  accountId: string,
  resource: string,
  action: PolicyAction,
): Promise<Decision> {
  const ctx = await loadContext(db, p.userId, accountId);
  if (!ctx) {
    return {
      allow: false,
      needsApproval: false,
      reason: 'user not found',
      level: 'none',
      source: 'default',
    };
  }
  return decide(ctx, p, resource, action);
}

/** Accounts of the user that `p` may perform `action` on `resource` for. */
export async function allowedAccounts(
  db: Db,
  p: Principal,
  resource: string,
  action: PolicyAction,
): Promise<{ accountId: string; provider: string; decision: Decision }[]> {
  const rows = await db
    .select({ id: accounts.id, provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.userId, p.userId));
  const out = [];
  for (const a of rows) {
    const decision = await can(db, p, a.id, resource, action);
    if (decision.allow) out.push({ accountId: a.id, provider: a.provider, decision });
  }
  return out;
}
