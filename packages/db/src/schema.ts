import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name'),
  timezone: text('timezone').notNull().default('UTC'),
  role: text('role'),
  preset: text('preset').notNull().default('balanced'),
  strictPersonal: boolean('strict_personal').notNull().default(true),
  /** Kill switch. Events still sync; no agent runs or sends. */
  paused: boolean('paused').notNull().default(false),
  settings: jsonb('settings').notNull().default({}),
  onboardedAt: ts('onboarded_at'),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
  lastUsedAt: ts('last_used_at'),
});

export const pushTokens = pgTable('push_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull(),
  createdAt: createdAt(),
});

/** Envelope-encrypted secrets. Everything else stores a `*_ref` pointing here. */
export const secrets = pgTable('secrets', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  keyId: text('key_id').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    nickname: text('nickname').notNull(),
    color: text('color').notNull(),
    /** Provider-side identity: email address, workspace id, site id. */
    externalId: text('external_id').notNull(),
    status: text('status').notNull().default('connecting'),
    /** Read-scope token. */
    tokenRef: uuid('token_ref').references(() => secrets.id, { onDelete: 'set null' }),
    /** Write-scope token from a separate consent; only the executor decrypts it. */
    writeTokenRef: uuid('write_token_ref').references(() => secrets.id, { onDelete: 'set null' }),
    filters: jsonb('filters').notNull().default({}),
    /** Deprecated: per-source cursors live on `subscriptions.cursor`. Kept for old rows. */
    syncCursor: text('sync_cursor'),
    /** Non-secret provider identity data: Slack team id, Atlassian cloud id and site URL, tenant. */
    meta: jsonb('meta').notNull().default({}),
    /**
     * Keys webhooks are routed by when the provider doesn't send our external id
     * (Slack team id, GitHub installation ids, Atlassian cloud id, Notion workspace id).
     */
    routeKeys: text('route_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isPersonal: boolean('is_personal').notNull().default(false),
    backfillDays: integer('backfill_days').notNull().default(30),
    lastSyncedAt: ts('last_synced_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('accounts_user_provider_external').on(t.userId, t.provider, t.externalId),
    index('accounts_provider_external_idx').on(t.provider, t.externalId),
    index('accounts_route_keys_idx').using('gin', t.routeKeys),
  ],
);

/**
 * One row per (account, source): a Google account has sources `mail`, `calendar`, `drive`,
 * `chat`; Microsoft has `mail`, `calendar`, `teams`, `onedrive`; and so on. Holds the push
 * subscription (if the source has one) and the delta cursor. `kind` is the source id.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    externalSubId: text('external_sub_id'),
    expiresAt: ts('expires_at'),
    /** Delta cursor for this source (history id, delta link, sync token, timestamp). */
    cursor: text('cursor'),
    /**
     * Non-secret subscription data. Webhook shared secrets (Graph clientState, Google
     * channel token) are stored only as `secretHash` and compared by the gateway.
     */
    meta: jsonb('meta').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('subscriptions_account_kind').on(t.accountId, t.kind),
    index('subscriptions_external_sub_idx').on(t.externalSubId),
  ],
);

/** Raw webhook events. `provider_event_id` is namespaced `<provider>:<id>` and unique for dedupe. */
export const events = pgTable('events', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull().unique(),
  payload: jsonb('payload').notNull().default({}),
  status: text('status').notNull().default('received'),
  createdAt: createdAt(),
});

/** Encrypted message bodies, stored apart from items with their own retention. */
export const itemBodies = pgTable('item_bodies', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull().default('text/plain'),
  keyId: text('key_id').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
});

export const items = pgTable(
  'items',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    threadId: text('thread_id'),
    author: text('author'),
    authorAddress: text('author_address'),
    title: text('title'),
    bodyRef: uuid('body_ref').references(() => itemBodies.id, { onDelete: 'set null' }),
    summary: text('summary'),
    url: text('url'),
    labels: jsonb('labels').notNull().default([]),
    /** Set by triage: needs_you | fyi | ignore. */
    bucket: text('bucket'),
    statusLabel: text('status_label'),
    triage: jsonb('triage'),
    receivedAt: ts('received_at').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('items_account_external').on(t.accountId, t.externalId),
    index('items_account_received_idx').on(t.accountId, t.receivedAt),
    index('items_thread_idx').on(t.accountId, t.threadId),
  ],
);

export const people = pgTable('people', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'),
  emails: text('emails')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  handles: jsonb('handles').notNull().default({}),
  isVip: boolean('is_vip').notNull().default(false),
  createdAt: createdAt(),
});

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: ts('due_at'),
    status: text('status').notNull().default('open'),
    project: text('project'),
    sourceItemId: uuid('source_item_id').references(() => items.id, { onDelete: 'set null' }),
    confidence: real('confidence'),
    confirmedByUser: boolean('confirmed_by_user'),
    createdBy: text('created_by').notNull().default('user'),
    /** Stable key so re-running the extractor never duplicates a task. */
    dedupeKey: text('dedupe_key'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('tasks_user_dedupe').on(t.userId, t.dedupeKey),
    index('tasks_user_status_idx').on(t.userId, t.status),
  ],
);

export const briefs = pgTable(
  'briefs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Local date in the user's timezone, YYYY-MM-DD. */
    date: text('date').notNull(),
    headline: text('headline').notNull(),
    bullets: jsonb('bullets').notNull().default([]),
    model: text('model'),
    createdAt: createdAt(),
  },
  (t) => [unique('briefs_user_date').on(t.userId, t.date)],
);

export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** `agent:reply` or `mcp:<clientId>`. */
    agent: text('agent').notNull(),
    model: text('model'),
    action: text('action').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    sourceItemId: uuid('source_item_id').references(() => items.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    executedAt: ts('executed_at'),
    result: jsonb('result'),
    error: text('error'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index('proposals_user_status_idx').on(t.userId, t.status)],
);

/**
 * `account_id` NULL + `provider` set = all accounts of that provider.
 * `account_id` set = account-specific override. Both NULL = every account.
 */
export const policies = pgTable(
  'policies',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    principal: text('principal').notNull(),
    provider: text('provider'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    level: text('level').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('policies_scope')
      .on(t.userId, t.principal, t.provider, t.accountId, t.resource)
      .nullsNotDistinct(),
  ],
);

export const accessRequests = pgTable('access_requests', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** access = temporary grant; mcp_connect = a new MCP client asking to connect. */
  kind: text('kind').notNull().default('access'),
  principal: text('principal').notNull(),
  clientName: text('client_name'),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  provider: text('provider'),
  resource: text('resource').notNull(),
  level: text('level').notNull().default('read'),
  reason: text('reason'),
  durationMinutes: integer('duration_minutes'),
  meta: jsonb('meta').notNull().default({}),
  status: text('status').notNull().default('pending'),
  createdAt: createdAt(),
  decidedAt: ts('decided_at'),
});

export const grants = pgTable('grants', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  principal: text('principal').notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  provider: text('provider'),
  /** Resource the grant covers, e.g. `email`. */
  scope: text('scope').notNull(),
  level: text('level').notNull().default('read'),
  accessRequestId: uuid('access_request_id').references(() => accessRequests.id, {
    onDelete: 'set null',
  }),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const providers = pgTable('providers', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  /** Non-secret settings (region, base URL). */
  config: jsonb('config').notNull().default({}),
  secretRef: uuid('secret_ref').references(() => secrets.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('unverified'),
  createdAt: createdAt(),
});

export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    /** NULL = the hub's recommended provider. */
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    fallback: boolean('fallback').notNull().default(true),
  },
  (t) => [unique('agent_configs_user_agent').on(t.userId, t.agent)],
);

export const modelUsage = pgTable(
  'model_usage',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    providerKind: text('provider_kind').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    ok: boolean('ok').notNull().default(true),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('model_usage_user_at_idx').on(t.userId, t.at)],
);

/** OAuth clients registered by MCP hosts (dynamic client registration). */
export const mcpOauthClients = pgTable('mcp_oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecretHash: text('client_secret_hash'),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: createdAt(),
});

export const mcpAuthCodes = pgTable('mcp_auth_codes', {
  id: id(),
  codeHash: text('code_hash').notNull().unique(),
  clientId: text('client_id')
    .notNull()
    .references(() => mcpOauthClients.clientId, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scopes: jsonb('scopes').notNull().default([]),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/** One row per connected MCP client per user, holding its scoped token. */
export const mcpClients = pgTable('mcp_clients', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  oauthClientId: text('oauth_client_id').references(() => mcpOauthClients.clientId, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  refreshTokenHash: text('refresh_token_hash').unique(),
  scopes: jsonb('scopes').notNull().default([]),
  expiresAt: ts('expires_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

/** Append-only. UPDATE is blocked by a trigger; DELETE only inside the delete-everything job. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    principal: text('principal').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    /** Ids and decisions only. Never message text, tokens or keys. */
    details: jsonb('details'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_user_at_idx').on(t.userId, t.at)],
);
