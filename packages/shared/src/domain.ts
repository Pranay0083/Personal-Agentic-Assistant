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
  /** Whole sources on/off (e.g. Google `calendar`, Slack `dms`); ids come from the connector catalog. */
  sources: z.record(z.string(), z.boolean()).default({}),
  /** Other provider-specific choices declared in the catalog (e.g. Slack `channels: 'joined'`). */
  options: z
    .record(z.string(), z.union([z.boolean(), z.string(), z.array(z.string())]))
    .default({}),
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
  /** The separate write consent ("Allow sending") has been granted. */
  writeAccess: z.boolean().default(false),
  /** A setup step the user still has to do at the provider (GitHub App install). */
  setup: z.object({ label: z.string(), url: z.string() }).nullable().default(null),
});
export type Account = z.infer<typeof Account>;

/** Label prefixes the API passes through to the app as `Item.refs`. Everything else stays server-side. */
export const ITEM_REF_PREFIXES = [
  'hub:mention',
  'hub:dm',
  'hub:review_requested',
  'hub:assigned',
  'hub:blocking:',
  'hub:rsvp_needed',
  'hub:from_me',
  'gcal:start:',
  'gcal:end:',
  'mscal:start:',
  'mscal:end:',
  'slack:channel_name:',
  'jira:key:',
  'jira:status:',
  'github:repo:',
  'github:number:',
  'github:type:',
] as const;

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
  /**
   * Display-safe references and signals from the connector (e.g. `gcal:start:<iso>`,
   * `jira:key:PROJ-1`, `slack:channel_name:api`, `hub:mention`). A filtered subset of the
   * item's labels; see ITEM_REF_PREFIXES.
   */
  refs: z.array(z.string()).default([]),
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
  'outlook.send',
  'slack.post',
  'jira.transition',
  'jira.comment',
]);
export type ProposalAction = z.infer<typeof ProposalAction>;

/** Email reply or new message. Used by `gmail.send` and `outlook.send`. */
export const EmailSendPayload = z.object({
  to: z.array(z.email()).min(1),
  cc: z.array(z.email()).default([]),
  subject: z.string(),
  body: z.string(),
  /** RFC 822 Message-ID being replied to (Gmail) or provider message id (Outlook). */
  inReplyTo: z.string().optional(),
  threadId: z.string().optional(),
});
export type EmailSendPayload = z.infer<typeof EmailSendPayload>;
export const GmailSendPayload = EmailSendPayload;
export type GmailSendPayload = EmailSendPayload;

/** Post to a Slack conversation. Channel and thread come from the stored item, never from a model. */
export const SlackPostPayload = z.object({
  /** Slack conversation id: C… (channel), G… (private/group), D… (DM). */
  channel: z.string().regex(/^[CDG][A-Z0-9]{2,20}$/),
  text: z.string().min(1).max(4000),
  /** Message timestamp of the thread parent, e.g. 1790596800.001000. */
  threadTs: z
    .string()
    .regex(/^\d{9,11}\.\d{6}$/)
    .optional(),
});
export type SlackPostPayload = z.infer<typeof SlackPostPayload>;

const IssueKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/);

/** Move a Jira issue through a transition, optionally with a comment. */
export const JiraTransitionPayload = z.object({
  issueKey: IssueKey,
  transitionId: z.string().min(1),
  /** Target status name, for display in Approvals. */
  toStatus: z.string(),
  comment: z.string().max(10000).optional(),
});
export type JiraTransitionPayload = z.infer<typeof JiraTransitionPayload>;

export const JiraCommentPayload = z.object({
  issueKey: IssueKey,
  body: z.string().min(1).max(10000),
});
export type JiraCommentPayload = z.infer<typeof JiraCommentPayload>;

/** Payload schema per action. The API (edits), MCP (propose) and executor all validate with these. */
export const PROPOSAL_PAYLOADS = {
  'gmail.send': EmailSendPayload,
  'outlook.send': EmailSendPayload,
  'slack.post': SlackPostPayload,
  'jira.transition': JiraTransitionPayload,
  'jira.comment': JiraCommentPayload,
} as const;

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
