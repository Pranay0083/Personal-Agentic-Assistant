import type { AccountFilters, ItemKind, ProposalAction, Provider } from '@hub/shared';

/**
 * The interface every provider folder implements (CLAUDE.md "Connector interface").
 * Connectors are pure provider I/O: no database, no queue, no policy. Callers
 * (api, gateway, sync worker, executor) do policy checks, persistence and audit.
 *
 * An account has one or more **sources**: a Google account has `mail`, `calendar`,
 * `drive`, `chat`; Microsoft has `mail`, `calendar`, `teams`, `onedrive`; Slack has
 * `messages`. Each source has its own push subscription (if any) and delta cursor, stored
 * as one `subscriptions` row per (account, source). Every per-source call gets
 * `ctx.source`.
 */

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scope?: string;
};

/** `read` = read-only scopes (connect flow). `write` = separate consent used only by the executor. */
export type AccessKind = 'read' | 'write';

export type ConnectorContext = {
  accountId: string;
  /** Provider identity, e.g. the Gmail address, `T123:U456` for Slack, the Atlassian cloud id. */
  externalId: string;
  tokens: OAuthTokens;
  /** Called when the connector refreshes tokens, so the caller can re-encrypt and store them. */
  saveTokens: (tokens: OAuthTokens) => Promise<void>;
  /**
   * Re-reads the stored tokens. Accounts from one consent share a grant, so a sibling may
   * have rotated the refresh token first; the oauth2 helper retries with the stored one.
   */
  reloadTokens?: () => Promise<OAuthTokens>;
  /**
   * Runs a token refresh while holding a lock on the shared grant, so sibling accounts
   * don't refresh a rotating refresh token at the same moment.
   */
  withRefreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Source this call is for (defaults to the connector's first source). */
  source?: string;
  /** Delta cursor of `source` (subscriptions.cursor). */
  cursor: string | null;
  filters: AccountFilters;
  /** Non-secret account data saved at connect time (accounts.meta), e.g. site URL, team id. */
  meta?: Record<string, unknown>;
  /** The source's current push subscription, if any. */
  subscription?: {
    externalSubId: string | null;
    expiresAt: Date | null;
    meta: Record<string, unknown>;
  } | null;
};

export type NormalizedItem = {
  kind: ItemKind;
  externalId: string;
  threadId: string | null;
  author: string | null;
  authorAddress: string | null;
  title: string | null;
  /** Short provider snippet. Untrusted. */
  summary: string | null;
  /** Full plain-text body. Untrusted. The caller encrypts it into item_bodies; never log it. */
  body: string | null;
  url: string | null;
  /**
   * Provider labels plus references agents and the executor need, as `<ns>:<key>:<value>`:
   * `rfc822msgid:<id>` (Gmail), `outlook:id:<id>`, `outlook:conversation:<id>`,
   * `slack:channel:<id>`, `slack:ts:<ts>`, `slack:thread:<ts>`, `teams:chat:<id>`,
   * `jira:key:<KEY>`, `jira:status:<name>`, `confluence:page:<id>`, `notion:page:<id>`,
   * `github:repo:<owner/name>`, `github:number:<n>`, `github:type:<issue|pr>`,
   * `gcal:event:<id>`, `gdrive:file:<id>`, `gchat:space:<name>`, `gchat:thread:<name>`.
   * Recipients and targets for replies come from these, never from model output.
   *
   * Trusted **signals** set from provider metadata (never inferred from message text); triage
   * and the extractor act on them directly: `hub:mention` (the user was @-mentioned),
   * `hub:dm` (1:1 conversation), `hub:review_requested`, `hub:assigned`,
   * `hub:blocking:<n>` (people or issues waiting on it), `hub:rsvp_needed` (invite not yet
   * answered), `hub:from_me` (the account owner wrote it).
   */
  labels: string[];
  receivedAt: Date;
  /** Sent by the account owner (e.g. Gmail SENT label, Slack message by the connected user). */
  fromMe: boolean;
};

export type WebhookRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string>;
  /** Optional sub-path after /hooks/:provider/, e.g. `channel` for Google Calendar/Drive pushes. */
  channel?: string | null;
  body: unknown;
  rawBody: string;
};

/**
 * One change notification. It must say which account(s) it is for, with exactly one of:
 * - `externalAccountId`: matches accounts.external_id (Gmail address)
 * - `routeKey`: matches any entry of accounts.route_keys (Slack team, GitHub installation)
 * - `externalSubId`: matches subscriptions.external_sub_id (Graph subscription, Google channel)
 */
export type WebhookEvent = {
  /** Unique per provider event; the gateway prefixes it with `<provider>:` for dedupe. */
  providerEventId: string;
  externalAccountId?: string;
  routeKey?: string;
  externalSubId?: string;
  /** Source to sync. Omit to sync every enabled source of the account. */
  source?: string;
  /**
   * Shared secret carried by the notification (Graph `clientState`, Google
   * `X-Goog-Channel-Token`). The gateway compares sha256(hex) of it with the matched
   * subscription's `meta.secretHash` and drops the event on mismatch.
   */
  subscriptionSecret?: string;
  /** Small, non-content metadata only (ids, cursors). Never message text. */
  payload: Record<string, unknown>;
};

export type WebhookReply = {
  status?: number;
  contentType?: string;
  body: string | Record<string, unknown>;
};

export type VerifyResult =
  | {
      ok: true;
      events: WebhookEvent[];
      /** Echo required by some providers (Slack url_verification, Graph validationToken). */
      reply?: WebhookReply;
    }
  | { ok: false; reason: string };

export type DeltaResult<Raw = unknown> = {
  records: Raw[];
  cursor: string | null;
  /** The stored cursor was too old; caller should run a backfill instead. */
  fullResyncRequired?: boolean;
  /** More changes are waiting; the caller should call fetchDelta again with the new cursor. */
  hasMore?: boolean;
};

export type BackfillPage<Raw = unknown> = { records: Raw[]; nextPageToken: string | null };

export type SubscriptionInfo = {
  externalSubId: string | null;
  expiresAt: Date | null;
  /** Starting cursor (Gmail historyId, Graph delta link) returned by the subscribe call. */
  cursor?: string | null;
  /**
   * Stored in subscriptions.meta. Put `secretHash` (sha256 hex of a random shared secret
   * you registered with the provider) here, never the secret itself.
   */
  meta?: Record<string, unknown>;
};

export type ExecuteResult = { externalId: string; [k: string]: unknown };

/** One provider identity produced by a consent. Several (e.g. Atlassian sites) share one grant. */
export type Identity = {
  externalId: string;
  displayName: string | null;
  routeKeys?: string[];
  meta?: Record<string, unknown>;
};

export type ExchangeResult = {
  tokens: OAuthTokens;
  /** First identity; kept for single-identity connectors. */
  externalId: string;
  displayName: string | null;
  /** All identities (defaults to the one above). Each becomes an account row. */
  identities?: Identity[];
};

export type SourceInfo = {
  id: string;
  label: string;
  hint: string | null;
  kind: ItemKind;
  defaultOn: boolean;
  /**
   * OAuth scope(s) this source needs. If the consent didn't grant them, the source is off.
   * Omit when a source needs nothing beyond the base scopes.
   */
  scopes?: string[];
};

export type OptionInfo = {
  key: string;
  label: string;
  hint: string | null;
  type: 'boolean' | 'choice';
  choices?: { value: string; label: string }[];
  default: boolean | string;
};

export type ConnectorInfo = {
  name: string;
  covers: string;
  multiAccountNote: string | null;
  sources: SourceInfo[];
  options: OptionInfo[];
  writeActions: ProposalAction[];
};

export interface Connector<Raw = unknown> {
  provider: Provider;
  /** Catalog data for the Connect and Scope screens. */
  info: ConnectorInfo;
  /** True when this server has the client credentials (or fake mode is on). */
  configured(): boolean;
  /**
   * True when the separate write consent can be offered safely. Providers that put every
   * scope a user granted to one app into its tokens (Slack, Microsoft) need a second,
   * write-only app; without it, "Allow sending" would give read tokens write scopes.
   * Missing means "yes" (Google and Atlassian scope tokens per consent).
   */
  writeConfigured?(): boolean;
  connect: {
    authUrl(opts: {
      state: string;
      redirectUri: string;
      access: AccessKind;
      loginHint?: string;
    }): string;
    /**
     * Pass `access` to have the connector check that the consent actually granted the
     * scopes for that access kind (throws MissingScopeError otherwise). A read consent
     * that includes any write scope must be rejected.
     */
    exchange(opts: {
      code: string;
      redirectUri: string;
      access?: AccessKind;
    }): Promise<ExchangeResult>;
    revoke(tokens: OAuthTokens): Promise<void>;
  };
  subscribe(ctx: ConnectorContext): Promise<SubscriptionInfo>;
  renew(ctx: ConnectorContext): Promise<SubscriptionInfo>;
  unsubscribe?(ctx: ConnectorContext): Promise<void>;
  verifyWebhook(req: WebhookRequest): Promise<VerifyResult>;
  fetchDelta(ctx: ConnectorContext): Promise<DeltaResult<Raw>>;
  backfill(
    ctx: ConnectorContext,
    opts: { days: number; pageToken?: string },
  ): Promise<BackfillPage<Raw>>;
  /** `source` is the source the record came from. */
  normalize(raw: Raw, source?: string): NormalizedItem | null;
  /**
   * Whether a normalized item passes the account's read filters (Scope screen).
   * Missing means "accept everything".
   */
  accepts?(item: NormalizedItem, filters: AccountFilters, source?: string): boolean;
  /** Write actions. Used only by apps/workers/executor, with write-scope tokens. */
  execute?(
    ctx: ConnectorContext,
    action: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ExecuteResult>;
  /**
   * Re-reads identity data that can change after connect (GitHub installations → route
   * keys, `needsInstall`). Sync calls it when an event payload has `refreshRouteKeys: true`.
   */
  refreshIdentity?(
    ctx: ConnectorContext,
  ): Promise<{ routeKeys?: string[]; meta?: Record<string, unknown> }>;
  /** Looks up whether an action with this idempotency key already happened (crash-safe retries). */
  findExecuted?(
    ctx: ConnectorContext,
    action: string,
    idempotencyKey: string,
    /** The proposal's payload, for lookups that need a target (Jira issue key, Slack channel). */
    payload?: Record<string, unknown>,
  ): Promise<ExecuteResult | null>;
}

/** All identities of an exchange result. */
export function identitiesOf(r: ExchangeResult): Identity[] {
  return r.identities?.length
    ? r.identities
    : [{ externalId: r.externalId, displayName: r.displayName }];
}

/**
 * Sources that should sync for an account: on by default or by the user's toggle
 * (`filters.sources`), and granted by the consent (`meta.grantedScopes`, when recorded).
 */
export function enabledSources(
  info: ConnectorInfo,
  filters: Pick<AccountFilters, 'sources'>,
  meta: Record<string, unknown> = {},
): string[] {
  const granted = Array.isArray(meta.grantedScopes) ? (meta.grantedScopes as string[]) : null;
  return info.sources
    .filter((s) => filters.sources?.[s.id] ?? s.defaultOn)
    .filter((s) => !granted || !s.scopes?.length || s.scopes.every((sc) => granted.includes(sc)))
    .map((s) => s.id);
}
