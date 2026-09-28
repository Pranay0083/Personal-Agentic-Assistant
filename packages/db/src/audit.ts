import type { Db } from './client';
import { auditLog } from './schema';

export type AuditEntry = {
  userId: string;
  /** `user`, `agent:<name>`, `mcp:<clientId>`, `system:<worker>`. */
  principal: string;
  action: string;
  target?: string | null;
  /** Ids and decisions only. Never message text, tokens or keys. */
  details?: Record<string, unknown>;
};

export async function audit(db: Db, entry: AuditEntry) {
  await db.insert(auditLog).values({
    userId: entry.userId,
    principal: entry.principal,
    action: entry.action,
    target: entry.target ?? null,
    details: entry.details ?? null,
  });
}
