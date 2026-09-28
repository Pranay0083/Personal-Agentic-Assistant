import type { AccountFilters, ItemKind, Provider } from '@hub/shared';

/**
 * The interface every provider folder implements (CLAUDE.md "Connector interface").
 * Connectors are pure provider I/O: no database, no queue, no policy. Callers
 * (api, gateway, sync worker, executor) do policy checks, persistence and audit.
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
  /** Provider identity, e.g. the Gmail address. */
  externalId: string;
  tokens: OAuthTokens;
  /** Called when the connector refreshes tokens, so the caller can re-encrypt and store them. */
  saveTokens: (tokens: OAuthTokens) => Promise<void>;
  cursor: string | null;
  filters: AccountFilters;
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
  labels: string[];
  receivedAt: Date;
  /** Sent by the account owner (e.g. Gmail SENT label). */
  fromMe: boolean;
};

export type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
};

export type WebhookEvent = {
  /** Unique per provider event; the gateway prefixes it with `<provider>:` for dedupe. */
  providerEventId: string;
  /** Maps to accounts.external_id. */
  externalAccountId: string;
  /** Small, non-content metadata only (ids, cursors). */
  payload: Record<string, unknown>;
};

export type VerifyResult =
  | {
      ok: true;
      events: WebhookEvent[];
      /** Some providers need a body echoed (challenges). */ reply?: unknown;
    }
  | { ok: false; reason: string };

export type DeltaResult<Raw = unknown> = {
  records: Raw[];
  cursor: string | null;
  /** The stored cursor was too old; caller should run a backfill instead. */
  fullResyncRequired?: boolean;
};

export type BackfillPage<Raw = unknown> = { records: Raw[]; nextPageToken: string | null };

export type SubscriptionInfo = {
  externalSubId: string | null;
  expiresAt: Date | null;
  /** Starting cursor (Gmail historyId) returned by the watch call. */
  cursor?: string | null;
};

export type ExecuteResult = { externalId: string; [k: string]: unknown };

export interface Connector<Raw = unknown> {
  provider: Provider;
  connect: {
    authUrl(opts: {
      state: string;
      redirectUri: string;
      access: AccessKind;
      loginHint?: string;
    }): string;
    exchange(opts: { code: string; redirectUri: string }): Promise<{
      tokens: OAuthTokens;
      externalId: string;
      displayName: string | null;
    }>;
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
  normalize(raw: Raw): NormalizedItem | null;
  /** Write actions. Used only by apps/workers/executor, with write-scope tokens. */
  execute?(
    ctx: ConnectorContext,
    action: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ExecuteResult>;
  /** Looks up whether an action with this idempotency key already happened (crash-safe retries). */
  findExecuted?(
    ctx: ConnectorContext,
    action: string,
    idempotencyKey: string,
  ): Promise<ExecuteResult | null>;
}
