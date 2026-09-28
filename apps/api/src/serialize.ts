import type {
  accessRequests,
  accounts,
  briefs,
  grants,
  items,
  proposals,
  providers,
  users,
} from '@hub/db';
import {
  AccountFilters,
  AccountStatus,
  BackfillDays,
  ItemBucket,
  Preset,
  Role,
  UserSettings,
  type Account,
  type AccessRequest,
  type Brief,
  type Grant,
  type Item,
  type ModelProviderConfig,
  type Proposal,
  type Task,
} from '@hub/shared';
import type { Me } from '@hub/shared/api';
import { iso } from './http';

type UserRow = typeof users.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;
type GrantRow = typeof grants.$inferSelect;
type AccessRequestRow = typeof accessRequests.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;

const safe = <T>(r: { success: true; data: T } | { success: false }, fallback: T): T =>
  r.success ? r.data : fallback;

export function userSettings(raw: unknown): UserSettings {
  return safe(UserSettings.safeParse(raw ?? {}), UserSettings.parse({}));
}

export function accountFilters(raw: unknown): AccountFilters {
  return safe(AccountFilters.safeParse(raw ?? {}), AccountFilters.parse({}));
}

export function toMe(u: UserRow): Me {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    timezone: u.timezone,
    role: safe(Role.nullable().safeParse(u.role), null),
    preset: safe(Preset.safeParse(u.preset), 'balanced'),
    strictPersonal: u.strictPersonal,
    paused: u.paused,
    settings: userSettings(u.settings),
    onboardedAt: iso(u.onboardedAt),
  };
}

export function toAccount(a: AccountRow): Account {
  return {
    id: a.id,
    provider: a.provider as Account['provider'],
    nickname: a.nickname,
    color: a.color,
    externalId: a.externalId,
    status: safe(AccountStatus.safeParse(a.status), 'connecting'),
    isPersonal: a.isPersonal,
    filters: accountFilters(a.filters),
    backfillDays: safe(BackfillDays.safeParse(a.backfillDays), 30),
    lastSyncedAt: iso(a.lastSyncedAt),
    createdAt: a.createdAt.toISOString(),
  };
}

export function toItem(i: ItemRow): Item {
  return {
    id: i.id,
    accountId: i.accountId,
    kind: i.kind as Item['kind'],
    externalId: i.externalId,
    threadId: i.threadId,
    author: i.author,
    title: i.title,
    summary: i.summary,
    url: i.url,
    bucket: safe(ItemBucket.nullable().safeParse(i.bucket), null),
    statusLabel: i.statusLabel,
    receivedAt: i.receivedAt.toISOString(),
  };
}

export type TaskJoinRow = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: Date | null;
  status: string;
  project: string | null;
  sourceItemId: string | null;
  accountId: string | null;
  source: string | null;
  confidence: number | null;
  confirmedByUser: boolean | null;
  createdBy: string;
  createdAt: Date;
};

export function toTask(t: TaskJoinRow): Task {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    dueAt: iso(t.dueAt),
    status: t.status as Task['status'],
    project: t.project,
    sourceItemId: t.sourceItemId,
    accountId: t.accountId,
    source: t.source,
    confidence: t.confidence,
    confirmedByUser: t.confirmedByUser,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

export function toProposal(p: ProposalRow): Proposal {
  return {
    id: p.id,
    accountId: p.accountId,
    agent: p.agent,
    model: p.model,
    action: p.action as Proposal['action'],
    title: p.title,
    payload: (p.payload ?? {}) as Record<string, unknown>,
    status: p.status as Proposal['status'],
    sourceItemId: p.sourceItemId,
    decidedAt: iso(p.decidedAt),
    executedAt: iso(p.executedAt),
    error: p.error,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toBrief(b: BriefRow): Brief {
  return {
    id: b.id,
    date: b.date,
    headline: b.headline,
    bullets: Array.isArray(b.bullets) ? (b.bullets as unknown[]).map(String) : [],
    createdAt: b.createdAt.toISOString(),
  };
}

export function toGrant(g: GrantRow): Grant {
  return {
    id: g.id,
    principal: g.principal,
    accountId: g.accountId,
    resource: g.scope as Grant['resource'],
    level: g.level as Grant['level'],
    expiresAt: g.expiresAt.toISOString(),
    createdAt: g.createdAt.toISOString(),
  };
}

export function toAccessRequest(r: AccessRequestRow): AccessRequest {
  return {
    id: r.id,
    kind: r.kind as AccessRequest['kind'],
    principal: r.principal,
    clientName: r.clientName,
    accountId: r.accountId,
    provider: r.provider,
    resource: r.resource,
    level: r.level as AccessRequest['level'],
    reason: r.reason,
    durationMinutes: r.durationMinutes,
    status: r.status as AccessRequest['status'],
    createdAt: r.createdAt.toISOString(),
  };
}

/** Never includes the secret; only whether one is stored. */
export function toModelProvider(p: ProviderRow): ModelProviderConfig {
  return {
    id: p.id,
    kind: p.kind as ModelProviderConfig['kind'],
    label: p.label,
    config: (p.config ?? {}) as Record<string, string>,
    hasSecret: p.secretRef !== null,
    status: p.status as ModelProviderConfig['status'],
    createdAt: p.createdAt.toISOString(),
  };
}
