import { and, eq } from 'drizzle-orm';
import { accounts, audit, users, type AuditEntry } from '@hub/db';
import type { LiveEvent } from '@hub/shared/queues';
import type { ApiDeps } from './deps';
import { errorFields, notFound } from './http';

/** What route modules get: the injected deps plus a few helpers built on them. */
export type Ctx = ApiDeps & {
  /** Publishes a live event; failures are logged, never fail the request. */
  live(userId: string, event: LiveEvent): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /** Loads the session user or 404s. */
  user(userId: string): Promise<typeof users.$inferSelect>;
  /** Loads one of the user's accounts or 404s. Other users' ids look exactly like missing ones. */
  account(userId: string, accountId: string): Promise<typeof accounts.$inferSelect>;
  warn(msg: string, extra?: Record<string, unknown>): void;
};

export function makeCtx(deps: ApiDeps, warn: Ctx['warn']): Ctx {
  return {
    ...deps,
    warn,
    async live(userId, event) {
      try {
        await deps.publishLive(userId, event);
      } catch (err) {
        warn('publishLive failed', { type: event.type, err: errorFields(err) });
      }
    },
    audit: (entry) => audit(deps.db, entry),
    async user(userId) {
      const [u] = await deps.db.select().from(users).where(eq(users.id, userId));
      if (!u) throw notFound('user');
      return u;
    },
    async account(userId, accountId) {
      const [a] = await deps.db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
      if (!a) throw notFound('account');
      return a;
    },
  };
}
