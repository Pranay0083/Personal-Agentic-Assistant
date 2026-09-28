/**
 * REST contract between apps/api and apps/mobile. Both sides import these schemas.
 * All routes except /auth/* and /oauth/* need `Authorization: Bearer <session token>`.
 * Timestamps are ISO strings. Secrets are never returned.
 */
import { z } from 'zod';
import {
  Account,
  AccountFilters,
  BackfillDays,
  Brief,
  Item,
  ItemBucket,
  ItemKind,
  Proposal,
  Provider,
  Role,
  Task,
  TaskStatus,
  UserSettings,
} from './domain';
import { AccessRequest, Grant, PolicyLevel, Preset, Resource } from './policy';
import { AgentConfig, ModelProviderConfig, ModelProviderKind } from './models';

export const Me = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  timezone: z.string(),
  role: Role.nullable(),
  preset: Preset,
  strictPersonal: z.boolean(),
  paused: z.boolean(),
  settings: UserSettings,
  onboardedAt: z.string().nullable(),
});
export type Me = z.infer<typeof Me>;

// ---- Auth ----
// POST /auth/dev          (only when DEV_AUTH=1)
export const DevSignInReq = z.object({ email: z.email(), name: z.string().optional() });
// POST /auth/google       (Google ID token from expo-auth-session)
export const GoogleSignInReq = z.object({ idToken: z.string() });
export const SignInRes = z.object({ token: z.string(), user: Me });
export type SignInRes = z.infer<typeof SignInRes>;
// POST /auth/sign-out     -> 204

// ---- Me ----
// GET /me -> Me
// PATCH /me
export const UpdateMeReq = z
  .object({
    name: z.string(),
    timezone: z.string(),
    role: Role,
    preset: Preset,
    strictPersonal: z.boolean(),
    settings: UserSettings.partial(),
    onboarded: z.literal(true),
  })
  .partial();
// POST /me/push-tokens
export const PushTokenReq = z.object({ token: z.string(), platform: z.enum(['ios', 'android']) });

// ---- Accounts ----
// GET /accounts -> { accounts }
export const AccountsRes = z.object({ accounts: z.array(Account) });
// POST /accounts/:provider/connect -> { url }  (open in browser)
// GET /oauth/google/callback does NOT create the account. It stores the result against a
// single-use id and redirects to hub://connected?pending=<id> (or ?error=<code>). The app
// then calls POST /accounts/complete with its own session; the server checks that the
// session's user is the one who started the flow. This stops a consent link started by
// someone else from attaching your mailbox to their account.
export const ConnectReq = z.object({ redirectUri: z.string().optional() });
export const ConnectRes = z.object({ url: z.string() });
// POST /accounts/complete -> CompleteConnectRes
export const CompleteConnectReq = z.object({ pending: z.string().min(16).max(128) });
export const CompleteConnectRes = z.object({
  account: Account,
  access: z.enum(['read', 'write']),
});
export type CompleteConnectRes = z.infer<typeof CompleteConnectRes>;
// PATCH /accounts/:id -> Account
export const UpdateAccountReq = z
  .object({
    nickname: z.string().min(1).max(40),
    color: z.string(),
    filters: AccountFilters.partial(),
    backfillDays: BackfillDays,
    isPersonal: z.boolean(),
  })
  .partial();
// POST /accounts/:id/apply-settings-to-provider -> { updated: number }  ("Use these settings for my other Google accounts")
// POST /accounts/:id/write-access -> { url }  (separate consent for send scope; only the executor uses it)
// POST /accounts/:id/sync -> 202
// DELETE /accounts/:id -> 204  (revokes tokens, deletes items)

// ---- Items ----
// GET /items?accountId=&kind=&bucket=&cursor=&limit=
export const ItemsQuery = z.object({
  accountId: z.uuid().optional(),
  kind: ItemKind.optional(),
  bucket: ItemBucket.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ItemsRes = z.object({
  items: z.array(Item),
  nextCursor: z.string().nullable(),
  counts: z.object({ all: z.number(), needsYou: z.number() }),
});
// GET /items/:id -> { item, body: string | null }   (body only for the user principal)

// ---- Tasks ----
// GET /tasks?status=open|done|dismissed&review=pending
export const TasksQuery = z.object({
  status: TaskStatus.optional(),
  review: z.enum(['pending']).optional(),
});
export const TasksRes = z.object({ tasks: z.array(Task) });
// POST /tasks -> Task
export const CreateTaskReq = z.object({
  title: z.string().min(1),
  dueAt: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
// PATCH /tasks/:id -> Task   (confirmedByUser feeds back into triage)
export const UpdateTaskReq = z
  .object({
    title: z.string().min(1),
    dueAt: z.string().nullable(),
    status: TaskStatus,
    project: z.string().nullable(),
    notes: z.string().nullable(),
    confirmedByUser: z.boolean(),
  })
  .partial();

// ---- Today ----
// GET /today
export const TodayRes = z.object({
  brief: Brief.nullable(),
  needsYou: z.array(Item),
  nextUp: z.array(Task),
  openTaskCount: z.number(),
  pendingApprovals: z.number(),
  lastSyncedAt: z.string().nullable(),
});
export type TodayRes = z.infer<typeof TodayRes>;

// ---- Approvals ----
// GET /proposals?status=pending -> { proposals }
export const ProposalsRes = z.object({ proposals: z.array(Proposal) });
// POST /proposals/:id/approve  { payload? }  (edited payload replaces the draft) -> Proposal
export const ApproveProposalReq = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});
// POST /proposals/:id/reject -> Proposal
// GET /access-requests?status=pending -> { requests }
export const AccessRequestsRes = z.object({ requests: z.array(AccessRequest) });
// POST /access-requests/:id/allow { durationMinutes } -> { grant: Grant | null }
export const AllowAccessReq = z.object({
  durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /**
   * Required for kind `mcp_connect`: the pairing code shown on the computer's consent page.
   * Proves the person tapping Allow is looking at that page, not a phishing copy of it.
   */
  pairingCode: z.string().min(4).max(16).optional(),
});
// POST /access-requests/:id/deny -> 204

// ---- Permissions ----
// GET /permissions?principal=agent:triage -> matrix for the Permissions screen
export const PermissionRow = z.object({
  resource: Resource,
  provider: z.string().nullable(),
  accountId: z.uuid().nullable(),
  label: z.string(),
  scope: z.string(),
  level: PolicyLevel,
  /** Where the level came from: grant, account, provider, preset. */
  source: z.enum(['grant', 'account', 'provider', 'preset']),
});
export const PermissionsRes = z.object({
  principal: z.string(),
  preset: Preset,
  principals: z.array(z.object({ key: z.string(), label: z.string() })),
  data: z.array(PermissionRow),
  actions: z.array(PermissionRow),
  grants: z.array(Grant),
});
export type PermissionsRes = z.infer<typeof PermissionsRes>;
// PUT /policies -> 204
export const SetPolicyReq = z.object({
  principal: z.string(),
  provider: z.string().nullable(),
  accountId: z.uuid().nullable(),
  resource: Resource,
  level: PolicyLevel,
});
// DELETE /grants/:id -> 204

// ---- Control ----
// GET /control -> ControlRes ; POST /control/pause ; POST /control/resume
export const ControlRes = z.object({
  paused: z.boolean(),
  activeAgents: z.number(),
  lastEventAt: z.string().nullable(),
  accountsCount: z.number(),
  accountsNeedingAttention: z.array(
    z.object({ id: z.uuid(), nickname: z.string(), provider: Provider }),
  ),
  temporaryGrants: z.number(),
  connectedClients: z.array(z.string()),
});
export type ControlRes = z.infer<typeof ControlRes>;

// ---- Models ----
// GET /models -> ModelsRes
export const ModelsRes = z.object({
  agents: z.array(AgentConfig),
  providers: z.array(ModelProviderConfig),
  options: z.array(
    z.object({ providerKind: ModelProviderKind, model: z.string(), label: z.string() }),
  ),
});
// PUT /models/agents/:agent  AgentConfig (sans agent) -> AgentConfig
export const SetAgentModelReq = AgentConfig.omit({ agent: true });
// POST /models/providers -> ModelProviderConfig   (secret is encrypted server-side, never echoed)
export const AddProviderReq = z.object({
  kind: ModelProviderKind,
  label: z.string().optional(),
  config: z.record(z.string(), z.string()).default({}),
  secret: z.string().optional(),
});
// DELETE /models/providers/:id -> 204

// ---- MCP clients ----
// GET /mcp -> { url, command, clients }
export const McpInfoRes = z.object({
  url: z.string(),
  command: z.string(),
  clients: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      lastUsedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
// DELETE /mcp/clients/:id -> 204

// ---- Activity ----
// GET /activity?cursor= -> { entries, nextCursor }
export const ActivityEntry = z.object({
  id: z.string(),
  principal: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
});
export const ActivityRes = z.object({
  entries: z.array(ActivityEntry),
  nextCursor: z.string().nullable(),
});

// ---- Ask ----
// POST /ask { question } -> { answer, sources: itemIds }
export const AskReq = z.object({ question: z.string().min(1).max(2000) });
export const AskRes = z.object({ answer: z.string(), sources: z.array(z.uuid()) });

// ---- Live updates ----
// GET /events (text/event-stream). Each message's data is a LiveEvent from @hub/shared/queues.
// EventSource can't set headers, so it may pass ?token=<session token>.

export const ErrorRes = z.object({ error: z.string(), message: z.string().optional() });
