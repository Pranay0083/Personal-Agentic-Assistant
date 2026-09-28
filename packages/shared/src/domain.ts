import { z } from 'zod';

/** Providers we can connect. One user may connect several accounts per provider. */
export const Provider = z.enum(['gmail', 'microsoft', 'slack', 'atlassian', 'notion', 'github']);
export type Provider = z.infer<typeof Provider>;

export const AccountStatus = z.enum([
  'connecting',
  'importing',
  'live',
  'reconnect',
  'paused',
  'disconnected',
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const ACCOUNT_COLORS = ['#1F6F6B', '#3B5BA9', '#6B4FA0', '#8A5A2B'] as const;
export const AccountColor = z.enum(ACCOUNT_COLORS);

export const BackfillDays = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type BackfillDays = z.infer<typeof BackfillDays>;

/** Per-account read filters (Scope screen). Gmail uses labels; other providers use their own keys. */
export const AccountFilters = z.object({
  inbox: z.boolean().default(true),
  sent: z.boolean().default(true),
  promotions: z.boolean().default(false),
  labels: z.array(z.string()).default([]),
});
export type AccountFilters = z.infer<typeof AccountFilters>;

export const Account = z.object({
  id: z.uuid(),
  provider: Provider,
  nickname: z.string(),
  color: z.string(),
  externalId: z.string(),
  status: AccountStatus,
  isPersonal: z.boolean(),
  filters: AccountFilters,
  backfillDays: BackfillDays,
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Account = z.infer<typeof Account>;

export const ItemKind = z.enum(['email', 'chat', 'ticket', 'note', 'event', 'file', 'code']);
export type ItemKind = z.infer<typeof ItemKind>;

export const ItemBucket = z.enum(['needs_you', 'fyi', 'ignore']);
export type ItemBucket = z.infer<typeof ItemBucket>;

export const Item = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  kind: ItemKind,
  externalId: z.string(),
  threadId: z.string().nullable(),
  author: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  bucket: ItemBucket.nullable(),
  /** Short status chip shown in the Inbox, e.g. "Task created", "Draft ready". */
  statusLabel: z.string().nullable(),
  receivedAt: z.string(),
});
export type Item = z.infer<typeof Item>;

export const TaskStatus = z.enum(['open', 'done', 'dismissed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.uuid(),
  title: z.string(),
  notes: z.string().nullable(),
  dueAt: z.string().nullable(),
  status: TaskStatus,
  project: z.string().nullable(),
  sourceItemId: z.uuid().nullable(),
  accountId: z.uuid().nullable(),
  /** Provider of the source item, for the source tag (GMAIL, JIRA...). */
  source: z.string().nullable(),
  confidence: z.number().nullable(),
  /** null = not reviewed, true = confirmed, false = rejected ("Not a task"). */
  confirmedByUser: z.boolean().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const ProposalStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
  'expired',
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** Write actions the executor knows how to perform. */
export const ProposalAction = z.enum([
  'gmail.send',
  'gmail.label',
  'jira.transition',
  'slack.post',
]);
export type ProposalAction = z.infer<typeof ProposalAction>;

export const GmailSendPayload = z.object({
  to: z.array(z.email()).min(1),
  cc: z.array(z.email()).default([]),
  subject: z.string(),
  body: z.string(),
  inReplyTo: z.string().optional(),
  threadId: z.string().optional(),
});
export type GmailSendPayload = z.infer<typeof GmailSendPayload>;

export const Proposal = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  agent: z.string(),
  /** Model that produced it, for the "REPLY AGENT · SONNET 5" label. */
  model: z.string().nullable(),
  action: ProposalAction,
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: ProposalStatus,
  sourceItemId: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const Brief = z.object({
  id: z.uuid(),
  date: z.string(),
  headline: z.string(),
  bullets: z.array(z.string()),
  createdAt: z.string(),
});
export type Brief = z.infer<typeof Brief>;

export const Role = z.enum(['build', 'lead', 'run', 'student', 'mix']);
export type Role = z.infer<typeof Role>;

export const QuietHours = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const UserSettings = z.object({
  quietHours: QuietHours.default({ start: '22:00', end: '07:00' }),
  /** Email addresses or handles whose messages notify instantly. */
  vips: z.array(z.string()).default([]),
  briefTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('07:30'),
  notificationsEnabled: z.boolean().default(false),
  /** Cloud models see summaries only, never full email bodies. */
  keepBodiesLocal: z.boolean().default(false),
  monthlyCapUsd: z.number().nonnegative().nullable().default(null),
});
export type UserSettings = z.infer<typeof UserSettings>;
