/**
 * Typed client for the REST contract in packages/shared/src/api.ts.
 * Every response is parsed with the shared zod schema, so a contract drift fails loudly
 * instead of rendering garbage.
 */
import {
  AccessRequestsRes,
  AccountsRes,
  ActivityRes,
  AskRes,
  CompleteConnectRes,
  ControlRes,
  ErrorRes,
  ItemsRes,
  McpInfoRes,
  Me,
  ModelsRes,
  PermissionsRes,
  ProposalsRes,
  SignInRes,
  TasksRes,
  TodayRes,
  type CreateTaskReq,
  type SetAgentModelReq,
  type SetPolicyReq,
  type UpdateAccountReq,
  type UpdateMeReq,
  type UpdateTaskReq,
  type AddProviderReq,
  type ItemsQuery,
  type TasksQuery,
  ConnectRes,
} from '@hub/shared/api';
import {
  Account,
  Grant,
  Item,
  ModelProviderConfig,
  AgentConfig,
  Proposal,
  Task,
  type Provider,
} from '@hub/shared';
import { API_URL } from './config';

/** Anything with a zod-style `parse`. Lets us infer types without importing zod here. */
type Parser<T> = { parse(data: unknown): T };
export type Infer<S extends Parser<unknown>> = ReturnType<S['parse']>;

export type MeT = Infer<typeof Me>;
export type AccountT = Infer<typeof Account>;
export type ItemT = Infer<typeof Item>;
export type TaskT = Infer<typeof Task>;
export type ProposalT = Infer<typeof Proposal>;
export type GrantT = Infer<typeof Grant>;
export type TodayT = Infer<typeof TodayRes>;
export type ItemsResT = Infer<typeof ItemsRes>;
export type TasksResT = Infer<typeof TasksRes>;
export type ProposalsResT = Infer<typeof ProposalsRes>;
export type AccessRequestsResT = Infer<typeof AccessRequestsRes>;
export type AccessRequestT = AccessRequestsResT['requests'][number];
export type PermissionsT = Infer<typeof PermissionsRes>;
export type PermissionRowT = PermissionsT['data'][number];
export type ControlT = Infer<typeof ControlRes>;
export type ModelsT = Infer<typeof ModelsRes>;
export type AgentConfigT = Infer<typeof AgentConfig>;
export type ModelProviderT = Infer<typeof ModelProviderConfig>;
export type McpInfoT = Infer<typeof McpInfoRes>;
export type ActivityT = Infer<typeof ActivityRes>;
export type ActivityEntryT = ActivityT['entries'][number];
export type AskT = Infer<typeof AskRes>;
export type SignInT = Infer<typeof SignInRes>;
export type CompleteConnectT = CompleteConnectRes;

export type UpdateMe = Infer<typeof UpdateMeReq>;
export type UpdateAccount = Infer<typeof UpdateAccountReq>;
export type UpdateTask = Infer<typeof UpdateTaskReq>;
export type CreateTask = Infer<typeof CreateTaskReq>;
export type SetPolicy = Infer<typeof SetPolicyReq>;
export type SetAgentModel = Infer<typeof SetAgentModelReq>;
export type AddProvider = Infer<typeof AddProviderReq>;
export type ItemsFilter = Partial<Omit<Infer<typeof ItemsQuery>, 'limit'>> & { limit?: number };
export type TasksFilter = Infer<typeof TasksQuery>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---- Session token (set by AuthProvider) ----
let sessionToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
}
export function getSessionToken() {
  return sessionToken;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** IANA timezone of the device, sent as X-Timezone so the hub schedules briefs in local time. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function send(method: Method, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const tz = deviceTimezone();
  if (tz) headers['X-Timezone'] = tz;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach your hub. Check your connection.");
  } finally {
    clearTimeout(timer);
  }

  const text = res.status === 204 ? '' : await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && sessionToken && !path.startsWith('/auth/')) onUnauthorized?.();
    const err = ErrorRes.safeParse(json);
    const code = err.success ? err.data.error : `http_${res.status}`;
    const message = err.success
      ? (err.data.message ?? err.data.error)
      : `Request failed (${res.status})`;
    throw new ApiError(res.status, code, message);
  }
  return json;
}

async function call<T>(
  method: Method,
  path: string,
  schema: Parser<T>,
  body?: unknown,
): Promise<T> {
  const json = await send(method, path, body);
  try {
    return schema.parse(json);
  } catch {
    throw new ApiError(0, 'invalid_response', 'Your hub sent something this app did not expect.');
  }
}

async function callVoid(method: Method, path: string, body?: unknown): Promise<void> {
  await send(method, path, body);
}

/** Parse when the contract leaves the response shape open; never throw on a shape mismatch. */
async function callMaybe<T>(
  method: Method,
  path: string,
  schema: Parser<T>,
  body?: unknown,
): Promise<T | null> {
  const json = await send(method, path, body);
  try {
    return schema.parse(json);
  } catch {
    return null;
  }
}

/** Hand-written parsers for responses the contract describes only in comments. */
const ItemDetail: Parser<{ item: ItemT; body: string | null }> = {
  parse(data) {
    const d = data as { item?: unknown; body?: unknown } | null;
    const item = Item.parse(d?.item);
    const body = typeof d?.body === 'string' ? d.body : null;
    return { item, body };
  },
};
const UrlRes: Parser<{ url: string }> = ConnectRes;
const UpdatedRes: Parser<{ updated: number }> = {
  parse(data) {
    const n = (data as { updated?: unknown } | null)?.updated;
    return { updated: typeof n === 'number' ? n : 0 };
  },
};
const AllowRes: Parser<{ grant: GrantT | null }> = {
  parse(data) {
    const g = (data as { grant?: unknown } | null)?.grant;
    return { grant: g ? Grant.parse(g) : null };
  },
};

export const api = {
  // Auth
  devSignIn: (email: string, name?: string) =>
    call('POST', '/auth/dev', SignInRes, { email, name }),
  googleSignIn: (idToken: string) => call('POST', '/auth/google', SignInRes, { idToken }),
  /** Pass this device's push token so the hub stops sending it this user's notifications. */
  signOut: (pushToken?: string | null) =>
    callVoid('POST', '/auth/sign-out', pushToken ? { pushToken } : undefined),

  // Me
  me: () => call('GET', '/me', Me),
  updateMe: (patch: UpdateMe) => callMaybe('PATCH', '/me', Me, patch),
  addPushToken: (token: string, platform: 'ios' | 'android') =>
    callVoid('POST', '/me/push-tokens', { token, platform }),

  // Accounts
  accounts: () => call('GET', '/accounts', AccountsRes),
  connect: (provider: Provider, redirectUri?: string) =>
    call('POST', `/accounts/${provider}/connect`, UrlRes, { redirectUri }),
  /** Finishes a connect with this session; the hub checks it's the user who started it. */
  completeConnect: (pending: string) =>
    call<CompleteConnectT>('POST', '/accounts/complete', CompleteConnectRes, { pending }),
  updateAccount: (id: string, patch: UpdateAccount) =>
    callMaybe('PATCH', `/accounts/${id}`, Account, patch),
  applySettingsToProvider: (id: string) =>
    call('POST', `/accounts/${id}/apply-settings-to-provider`, UpdatedRes),
  syncAccount: (id: string) => callVoid('POST', `/accounts/${id}/sync`),

  // Items
  items: (q: ItemsFilter) =>
    call(
      'GET',
      `/items${qs({ accountId: q.accountId, kind: q.kind, bucket: q.bucket, cursor: q.cursor, limit: q.limit })}`,
      ItemsRes,
    ),
  item: (id: string) => call('GET', `/items/${id}`, ItemDetail),

  // Tasks
  tasks: (q: Partial<TasksFilter>) =>
    call('GET', `/tasks${qs({ status: q.status, review: q.review })}`, TasksRes),
  createTask: (body: CreateTask) => call('POST', '/tasks', Task, body),
  updateTask: (id: string, patch: UpdateTask) => callMaybe('PATCH', `/tasks/${id}`, Task, patch),

  // Today
  today: () => call('GET', '/today', TodayRes),

  // Approvals
  proposals: () => call('GET', '/proposals?status=pending', ProposalsRes),
  approveProposal: (id: string, payload?: Record<string, unknown>) =>
    callMaybe('POST', `/proposals/${id}/approve`, Proposal, payload ? { payload } : {}),
  rejectProposal: (id: string) => callMaybe('POST', `/proposals/${id}/reject`, Proposal, {}),
  accessRequests: () => call('GET', '/access-requests?status=pending', AccessRequestsRes),
  /** `pairingCode` is required for `mcp_connect`: the code shown on the computer. */
  allowAccess: (id: string, durationMinutes: number, pairingCode?: string) =>
    call(
      'POST',
      `/access-requests/${id}/allow`,
      AllowRes,
      pairingCode ? { durationMinutes, pairingCode } : { durationMinutes },
    ),
  denyAccess: (id: string) => callVoid('POST', `/access-requests/${id}/deny`),

  // Permissions
  permissions: (principal?: string) =>
    call('GET', `/permissions${qs({ principal })}`, PermissionsRes),
  setPolicy: (body: SetPolicy) => callVoid('PUT', '/policies', body),
  revokeGrant: (id: string) => callVoid('DELETE', `/grants/${id}`),

  // Control
  control: () => call('GET', '/control', ControlRes),
  pause: () => callMaybe('POST', '/control/pause', ControlRes),
  resume: () => callMaybe('POST', '/control/resume', ControlRes),

  // Models
  models: () => call('GET', '/models', ModelsRes),
  setAgentModel: (agent: string, body: SetAgentModel) =>
    callMaybe('PUT', `/models/agents/${agent}`, AgentConfig, body),
  /** The secret goes straight to the server, which encrypts it. It is never stored on the phone. */
  addProvider: (body: AddProvider) => call('POST', '/models/providers', ModelProviderConfig, body),
  removeProvider: (id: string) => callVoid('DELETE', `/models/providers/${id}`),

  // MCP
  mcp: () => call('GET', '/mcp', McpInfoRes),
  removeMcpClient: (id: string) => callVoid('DELETE', `/mcp/clients/${id}`),

  // Activity
  activity: (cursor?: string) => call('GET', `/activity${qs({ cursor })}`, ActivityRes),

  // Ask
  ask: (question: string) => call('POST', '/ask', AskRes, { question }),
};

/** Friendly copy for error codes the API documents. */
const FRIENDLY: Record<string, string> = {
  budget_exceeded: "You've reached this month's model budget. Raise the cap in Control → Models.",
  model_unavailable: 'The model is unavailable right now. Try again in a minute.',
  not_pending: 'Already decided, maybe on another device.',
  rate_limited: 'Too many requests. Try again in a moment.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return FRIENDLY[e.code] ?? e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
