import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accounts, policies, users, type Db } from '@hub/db';
import { strictPersonalPolicies } from '@hub/policy';
import type { PolicyLevel, Resource } from '@hub/shared';

type Upsert = {
  principal: string;
  provider: string | null;
  accountId: string | null;
  resource: Resource | string;
  level: PolicyLevel;
};

/** Upserts policy rows on the unique scope (user, principal, provider, account, resource). */
export async function upsertPolicies(db: Db, userId: string, rows: Upsert[], now: Date) {
  if (rows.length === 0) return;
  await db
    .insert(policies)
    .values(rows.map((r) => ({ ...r, userId, createdAt: now, updatedAt: now })))
    .onConflictDoUpdate({
      target: [
        policies.userId,
        policies.principal,
        policies.provider,
        policies.accountId,
        policies.resource,
      ],
      set: { level: sql`excluded.level`, updatedAt: now },
    });
}

/** "Stricter for personal accounts": materialize the account-specific rules. */
export async function applyStrictPolicies(db: Db, userId: string, accountId: string, now: Date) {
  await upsertPolicies(db, userId, strictPersonalPolicies(accountId), now);
}

/**
 * Removes the strict rules for an account. Only rows that still hold the strict level are
 * removed, so a rule the user changed by hand on the Permissions screen survives.
 */
export async function removeStrictPolicies(db: Db, userId: string, accountId: string) {
  const byLevel = new Map<string, { principal: string; resource: string }[]>();
  for (const r of strictPersonalPolicies(accountId)) {
    const list = byLevel.get(r.level) ?? [];
    list.push({ principal: r.principal, resource: r.resource });
    byLevel.set(r.level, list);
  }
  for (const [level, rules] of byLevel) {
    for (const principal of new Set(rules.map((r) => r.principal))) {
      const resources = rules.filter((r) => r.principal === principal).map((r) => r.resource);
      await db
        .delete(policies)
        .where(
          and(
            eq(policies.userId, userId),
            eq(policies.accountId, accountId),
            isNull(policies.provider),
            eq(policies.principal, principal),
            eq(policies.level, level),
            inArray(policies.resource, resources),
          ),
        );
    }
  }
}

/** Brings one account's strict rules in line with the user's setting and the account flag. */
export async function syncStrictPolicies(db: Db, userId: string, accountId: string, now: Date) {
  const [row] = await db
    .select({ strict: users.strictPersonal, isPersonal: accounts.isPersonal })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) return;
  if (row.strict && row.isPersonal) await applyStrictPolicies(db, userId, accountId, now);
  else await removeStrictPolicies(db, userId, accountId);
}

/** After `strictPersonal` changes: apply or remove on every personal account. */
export async function syncAllStrictPolicies(db: Db, userId: string, now: Date) {
  const personal = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.isPersonal, true)));
  for (const a of personal) await syncStrictPolicies(db, userId, a.id, now);
}
