import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  enabledSources,
  identitiesOf,
  MissingScopeError,
  type Connector,
  type ExchangeResult,
  type Identity,
  type OAuthTokens,
} from '@hub/connectors';
import { accounts, subscriptions, users, type Db } from '@hub/db';
import { ACCOUNT_COLORS, AccountFilters, Provider, type Account } from '@hub/shared';
import {
  CompleteConnectReq,
  ConnectReq,
  UpdateAccountReq,
  type CompleteConnectRes,
} from '@hub/shared/api';
import { requestWriteTokenRevocation } from '@hub/server';
import { QUEUES } from '@hub/shared/queues';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, errorFields, HttpError, idParam, parse } from '../http';
import {
  CALLBACK_NAME,
  callbackUrl,
  checkAppRedirect,
  claimStateNonce,
  defaultAppRedirect,
  putPending,
  signState,
  takePending,
  verifyState,
  withQuery,
  type OAuthState,
} from '../oauth-state';
import { accountFilters, toAccount } from '../serialize';
import { applyStrictPolicies, syncStrictPolicies } from '../strict';
import { sentKeys } from './me';

type AccountRow = typeof accounts.$inferSelect;
type ConnectRes = { url: string };

/** Errors POST /accounts/complete can return, with their HTTP status. */
const CONNECT_ERROR_STATUS = {
  missing_scope: 400,
  exchange_failed: 502,
  invalid_state: 400,
  account_not_found: 404,
  account_mismatch: 409,
  already_connected: 409,
} as const;
type ConnectErrorCode = keyof typeof CONNECT_ERROR_STATUS;

async function auditConnectFailed(ctx: Ctx, state: OAuthState, error: string) {
  await ctx.audit({
    userId: state.userId,
    principal: 'user',
    action: 'account.connect_failed',
    details: { provider: state.provider, access: state.access, error },
  });
}

const PERSONAL_DOMAINS: Record<string, Set<string>> = {
  gmail: new Set(['gmail.com', 'googlemail.com']),
  microsoft: new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']),
};
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The provider's connector, or undefined if it isn't implemented. */
export function findConnector(ctx: Ctx, provider: string): Connector | undefined {
  try {
    return ctx.getConnector(provider as Provider) ?? undefined;
  } catch {
    return undefined;
  }
}

function isConfigured(c: Connector): boolean {
  try {
    return c.configured();
  } catch {
    return false;
  }
}

/** The connector for a provider that is implemented and configured on this server, or 400. */
export function lookupConnector(ctx: Ctx, provider: Provider): Connector {
  const c = findConnector(ctx, provider);
  if (!c || !isConfigured(c)) {
    throw new HttpError(400, 'unsupported_provider', `${provider} is not supported yet`);
  }
  return c;
}

/** Accounts (other than `except`) whose read or write token is this secret. */
async function secretUsers(
  db: Db,
  ref: string,
  column: 'read' | 'write',
  except?: string,
): Promise<string[]> {
  const col = column === 'read' ? accounts.tokenRef : accounts.writeTokenRef;
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(except ? and(eq(col, ref), ne(accounts.id, except)) : eq(col, ref));
  return rows.map((r) => r.id);
}

/** Scopes the consent granted, when the provider reports them (space or comma separated). */
function grantedScopes(tokens: OAuthTokens): string[] | null {
  if (!tokens.scope) return null;
  return tokens.scope.split(/[\s,]+/).filter(Boolean);
}

const objectOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};

/** Providers whose identity is a person (a mailbox); others name a workspace or site. */
const PERSON_IDENTITY = new Set<string>(['gmail', 'microsoft']);

/** The identity's display name when it names a workspace or site (Slack team, Jira site). */
function workspaceName(provider: string, displayName: string | null): string | null {
  const n = displayName?.trim();
  if (!n || PERSON_IDENTITY.has(provider) || n.includes('@')) return null;
  return n.slice(0, 40);
}

/** Secret kinds for OAuth tokens. The value is JSON of `OAuthTokens`. */
export const tokenKind = (provider: string, access: 'read' | 'write') =>
  access === 'read' ? `oauth:${provider}` : `oauth:${provider}:write`;

async function nextColor(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ color: accounts.color })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const used = new Set(rows.map((r) => r.color));
  return (
    ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[rows.length % ACCOUNT_COLORS.length]!
  );
}

async function defaultNickname(db: Db, userId: string, provider: string, base: string) {
  const rows = await db
    .select({ nickname: accounts.nickname })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)));
  const taken = new Set(rows.map((r) => r.nickname));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Meta field identifying the person, for providers whose external id is a shared resource. */
const PERSON_KEY: Partial<Record<string, string>> = { atlassian: 'atlassianAccountId' };

function isPersonalAddress(provider: string, externalId: string): boolean {
  const domains = PERSONAL_DOMAINS[provider];
  if (!domains) return false;
  const domain = externalId.split('@')[1]?.toLowerCase();
  return domain !== undefined && domains.has(domain);
}

/** Applies a PATCH to one account (also used by apply-settings-to-provider). */
async function updateAccount(
  ctx: Ctx,
  account: AccountRow,
  patch: {
    nickname?: string;
    color?: string;
    filters?: Partial<AccountFilters>;
    backfillDays?: 7 | 30 | 90;
    isPersonal?: boolean;
  },
): Promise<AccountRow> {
  const { db } = ctx;
  const set: Partial<typeof accounts.$inferInsert> = {};
  if (patch.nickname !== undefined) set.nickname = patch.nickname.trim() || account.nickname;
  if (patch.color !== undefined) {
    if (!HEX_COLOR.test(patch.color)) throw badRequest('color: expected #RRGGBB');
    set.color = patch.color;
  }
  const before = accountFilters(account.filters);
  let after = before;
  if (patch.filters !== undefined) {
    // Shallow merge, and per-key for the source and option maps: only sent keys change.
    after = AccountFilters.parse({
      ...before,
      ...patch.filters,
      sources: { ...before.sources, ...(patch.filters.sources ?? {}) },
      options: { ...before.options, ...(patch.filters.options ?? {}) },
    });
    set.filters = after;
  }
  if (patch.isPersonal !== undefined) set.isPersonal = patch.isPersonal;

  // Backfill runs when the window is first chosen (account still connecting) or widened.
  let backfill: 7 | 30 | 90 | null = null;
  if (patch.backfillDays !== undefined) {
    set.backfillDays = patch.backfillDays;
    if (account.status === 'connecting' || patch.backfillDays > account.backfillDays) {
      backfill = patch.backfillDays;
      set.status = 'importing';
    }
  }

  let updated = account;
  if (Object.keys(set).length > 0) {
    const [row] = await db
      .update(accounts)
      .set(set)
      .where(and(eq(accounts.id, account.id), eq(accounts.userId, account.userId)))
      .returning();
    if (row) updated = row;
  }
  if (patch.isPersonal !== undefined && patch.isPersonal !== account.isPersonal) {
    await syncStrictPolicies(db, account.userId, account.id, ctx.now());
  }
  const sourcesChanged =
    patch.filters?.sources !== undefined && (await applySourceToggles(ctx, account, before, after));
  if (backfill !== null) {
    await ctx.enqueue(
      QUEUES.backfill,
      { accountId: account.id, days: backfill },
      { jobId: `backfill:${account.id}:${backfill}` },
    );
  }
  if (Object.keys(set).length > 0) {
    await ctx.audit({
      userId: account.userId,
      principal: 'user',
      action: 'account.updated',
      target: `account:${account.id}`,
      details: {
        fields: Object.keys(set),
        ...(backfill ? { backfillDays: backfill } : {}),
        ...(sourcesChanged ? { sources: after.sources } : {}),
      },
    });
    await ctx.live(account.userId, { type: 'account.updated', accountId: account.id });
  }
  return updated;
}

/**
 * After `filters.sources` changed: flips `subscriptions.enabled` on the account's source rows
 * and enqueues a sync, which unsubscribes disabled sources and subscribes enabled ones.
 * Returns whether the set of enabled sources changed.
 */
async function applySourceToggles(
  ctx: Ctx,
  account: AccountRow,
  before: AccountFilters,
  after: AccountFilters,
): Promise<boolean> {
  const connector = findConnector(ctx, account.provider);
  if (!connector) return false;
  const meta = objectOf(account.meta);
  const was = enabledSources(connector.info, before, meta);
  const now = new Set(enabledSources(connector.info, after, meta));
  if (was.length === now.size && was.every((s) => now.has(s))) return false;
  const rows = await ctx.db
    .select({ id: subscriptions.id, kind: subscriptions.kind, enabled: subscriptions.enabled })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, account.id));
  for (const row of rows) {
    const want = now.has(row.kind);
    if (row.enabled === want) continue;
    await ctx.db
      .update(subscriptions)
      .set({ enabled: want, updatedAt: ctx.now() })
      .where(eq(subscriptions.id, row.id));
  }
  await ctx.enqueue(
    QUEUES.sync,
    { accountId: account.id, reason: 'manual' },
    { jobId: `sync-sources-${account.id}-${ctx.now().getTime()}` },
  );
  return true;
}

const ProviderParam = z.object({ provider: Provider });
const CallbackParam = z.object({ provider: z.string() });
const CallbackQuery = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, secrets, config } = ctx;

  app.get('/accounts', async (req): Promise<{ accounts: Account[] }> => {
    const rows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, req.auth.userId))
      .orderBy(asc(accounts.createdAt), asc(accounts.id));
    return { accounts: rows.map(toAccount) };
  });

  app.post('/accounts/:provider/connect', async (req): Promise<ConnectRes> => {
    const p = ProviderParam.safeParse(req.params);
    if (!p.success) throw new HttpError(400, 'unsupported_provider', 'unknown provider');
    const provider = p.data.provider;
    const body = parse(ConnectReq, req.body);
    const redirect = checkAppRedirect(config, body.redirectUri);
    const connector = lookupConnector(ctx, provider);
    const state = await signState(
      config,
      { userId: req.auth.userId, provider, access: 'read', ...(redirect ? { redirect } : {}) },
      ctx.now(),
    );
    return {
      url: connector.connect.authUrl({
        state,
        redirectUri: callbackUrl(config, provider),
        access: 'read',
      }),
    };
  });

  app.post('/accounts/:id/write-access', async (req): Promise<ConnectRes> => {
    const account = await ctx.account(req.auth.userId, idParam(req.params));
    const body = parse(ConnectReq, req.body);
    const redirect = checkAppRedirect(config, body.redirectUri);
    const provider = account.provider as Provider;
    const connector = lookupConnector(ctx, provider);
    if (connector.info.writeActions.length === 0) {
      throw new HttpError(400, 'write_not_supported', `${provider} has no write actions`);
    }
    if (connector.writeConfigured && !connector.writeConfigured()) {
      // Without a separate write app, the consent would add write scopes to the read token.
      throw new HttpError(
        400,
        'write_not_configured',
        `${provider} needs a separate write app on this hub`,
      );
    }
    const state = await signState(
      config,
      {
        userId: req.auth.userId,
        provider,
        access: 'write',
        accountId: account.id,
        ...(redirect ? { redirect } : {}),
      },
      ctx.now(),
    );
    return {
      url: connector.connect.authUrl({
        state,
        redirectUri: callbackUrl(config, provider),
        access: 'write',
        // Only mailbox identities make sense as a login hint (not `T123:U456` or a cloud id).
        ...(account.externalId.includes('@') ? { loginHint: account.externalId } : {}),
      }),
    };
  });

  // `:provider` is the callback name from CALLBACK_NAME (Gmail uses `google`); see callbackUrl.
  app.get('/oauth/:provider/callback', async (req, reply) => {
    const { provider: name } = parse(CallbackParam, req.params);
    const q = parse(CallbackQuery, req.query);
    const state = q.state ? await verifyState(config, q.state, ctx.now()) : null;
    if (!state || CALLBACK_NAME[state.provider] !== name) {
      throw new HttpError(400, 'invalid_state', 'OAuth state is missing, invalid or expired');
    }
    // A state is good for exactly one callback, whatever its outcome.
    if (!(await claimStateNonce(ctx.oauthStore, state))) {
      throw new HttpError(400, 'invalid_state', 'OAuth state was already used');
    }
    const back = state.redirect ?? defaultAppRedirect(config);
    const fail = async (error: string) => {
      await auditConnectFailed(ctx, state, error);
      return reply.redirect(
        withQuery(back, { error, ...(state.accountId ? { accountId: state.accountId } : {}) }),
        302,
      );
    };

    if (q.error) return fail(q.error === 'access_denied' ? 'access_denied' : 'oauth_error');
    if (!q.code) return fail('missing_code');

    // Nothing is exchanged or created here: whoever opened this URL may not be the user who
    // started the flow. The app finishes it with its own session via POST /accounts/complete.
    const pending = await putPending(ctx.oauthStore, ctx.keys, { code: q.code, state });
    return reply.redirect(withQuery(back, { pending }), 302);
  });

  app.post('/accounts/complete', async (req): Promise<CompleteConnectRes> => {
    const userId = req.auth.userId;
    const body = parse(CompleteConnectReq, req.body);
    const pending = await takePending(ctx.oauthStore, ctx.keys, body.pending);
    if (!pending) {
      throw new HttpError(400, 'connect_expired', 'connect result is missing, expired or used');
    }
    const { state, code } = pending;
    if (state.userId !== userId) {
      // Someone else started this flow: the consent (and its code) is discarded, never exchanged.
      const details = { provider: state.provider, access: state.access };
      await ctx.audit({
        userId,
        principal: 'user',
        action: 'account.connect_user_mismatch',
        details: { ...details, role: 'completer' },
      });
      await ctx.audit({
        userId: state.userId,
        principal: 'user',
        action: 'account.connect_user_mismatch',
        details: { ...details, role: 'starter' },
      });
      throw new HttpError(
        403,
        'connect_user_mismatch',
        'this connect was started by a different user',
      );
    }
    const fail = async (error: ConnectErrorCode): Promise<never> => {
      await auditConnectFailed(ctx, state, error);
      throw new HttpError(CONNECT_ERROR_STATUS[error], error, `connect failed: ${error}`);
    };

    const connector = lookupConnector(ctx, state.provider);
    let exchanged: ExchangeResult;
    try {
      exchanged = await connector.connect.exchange({
        code,
        redirectUri: callbackUrl(config, state.provider),
        // Makes the connector refuse a grant whose scopes don't match (rule 1).
        access: state.access,
      });
    } catch (err) {
      ctx.warn('oauth exchange failed', { provider: state.provider, err: errorFields(err) });
      return fail(err instanceof MissingScopeError ? 'missing_scope' : 'exchange_failed');
    }

    const stored =
      state.access === 'write'
        ? await storeWriteTokens(ctx, state, exchanged)
        : await storeReadTokens(ctx, state, exchanged);
    if (!Array.isArray(stored)) return fail(stored.error);
    const all: Account[] = [];
    for (const id of stored) all.push(toAccount(await ctx.account(userId, id)));
    return { account: all[0]!, accounts: all, access: state.access };
  });

  app.patch('/accounts/:id', async (req): Promise<Account> => {
    const account = await ctx.account(req.auth.userId, idParam(req.params));
    const body = parse(UpdateAccountReq, req.body);
    const rawFilters = (req.body as { filters?: unknown } | undefined)?.filters;
    const patch = {
      ...body,
      filters: body.filters ? sentKeys(body.filters, rawFilters) : undefined,
    };
    return toAccount(await updateAccount(ctx, account, patch));
  });

  app.post(
    '/accounts/:id/apply-settings-to-provider',
    async (req): Promise<{ updated: number }> => {
      const userId = req.auth.userId;
      const source = await ctx.account(userId, idParam(req.params));
      const others = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.provider, source.provider),
            ne(accounts.id, source.id),
          ),
        );
      const filters = accountFilters(source.filters);
      const backfillDays = toAccount(source).backfillDays;
      for (const other of others) await updateAccount(ctx, other, { filters, backfillDays });
      return { updated: others.length };
    },
  );

  app.post('/accounts/:id/sync', async (req, reply) => {
    const account = await ctx.account(req.auth.userId, idParam(req.params));
    // One manual sync per account per 10s window; repeated taps collapse into one job.
    const bucket = Math.floor(ctx.now().getTime() / 10_000);
    await ctx.enqueue(
      QUEUES.sync,
      { accountId: account.id, reason: 'manual' },
      { jobId: `sync-manual-${account.id}-${bucket}` },
    );
    await ctx.audit({
      userId: account.userId,
      principal: 'user',
      action: 'account.sync_requested',
      target: `account:${account.id}`,
    });
    return reply.code(202).send({ ok: true });
  });

  app.delete('/accounts/:id', async (req, reply) => {
    const userId = req.auth.userId;
    const account = await ctx.account(userId, idParam(req.params));
    await db.delete(accounts).where(and(eq(accounts.id, account.id), eq(accounts.userId, userId)));

    // Accounts from one consent share their token secret; it goes only with the last of them.
    // Checked after the row is gone, so two sibling deletes never both keep it.
    const readRef = account.tokenRef;
    const readShared = !!readRef && (await secretUsers(db, readRef, 'read')).length > 0;
    let revoked = false;
    if (readRef && !readShared) {
      // Best effort: revoke at the provider; a failure never blocks deletion.
      try {
        const connector = findConnector(ctx, account.provider);
        if (connector) {
          await connector.connect.revoke(await secrets.getJson<OAuthTokens>(readRef));
          revoked = true;
        }
      } catch (err) {
        ctx.warn('token revoke failed', { provider: account.provider, err: errorFields(err) });
      }
      await secrets.delete(readRef);
    }
    // The API can't decrypt write tokens (only the executor can), so the write token is
    // handed to the executor to revoke and delete, unless another account still uses it.
    const writeRef = account.writeTokenRef;
    const writeShared = !!writeRef && (await secretUsers(db, writeRef, 'write')).length > 0;
    if (writeRef && !writeShared) {
      await requestWriteTokenRevocation(ctx.enqueue, {
        userId,
        accountId: account.id,
        provider: account.provider,
        secretRef: writeRef,
      });
    }
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'account.deleted',
      target: `account:${account.id}`,
      details: {
        provider: account.provider,
        revoked,
        sharedTokenKept: readShared,
        writeRevocationQueued: !!writeRef && !writeShared,
      },
    });
    await ctx.live(userId, { type: 'account.updated', accountId: account.id });
    return reply.code(204).send();
  });
}

/**
 * Read-scope consent: creates or refreshes one account per identity (several Atlassian sites
 * from one consent, for example). All of them share one token secret. Returns the ids.
 */
async function storeReadTokens(
  ctx: Ctx,
  state: OAuthState,
  ex: ExchangeResult,
): Promise<string[] | { error: ConnectErrorCode }> {
  const { db, secrets } = ctx;
  const { userId, provider } = state;
  const now = ctx.now();

  // Stored as the connector returns them: the gateway maps webhook identities verbatim.
  const identities: Identity[] = [];
  for (const id of identitiesOf(ex)) {
    const externalId = id.externalId.trim();
    if (externalId && !identities.some((i) => i.externalId === externalId)) {
      identities.push({ ...id, externalId });
    }
  }
  if (identities.length === 0) return { error: 'exchange_failed' };

  const existing = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, provider),
        inArray(
          accounts.externalId,
          identities.map((i) => i.externalId),
        ),
      ),
    );
  const existingIds = new Set(existing.map((r) => r.id));

  // Reuse an existing secret only if every account using it is part of this consent.
  let reuse: string | null = null;
  for (const row of existing) {
    if (!row.tokenRef) continue;
    const usedBy = await secretUsers(db, row.tokenRef, 'read');
    if (usedBy.every((id) => existingIds.has(id))) {
      reuse = row.tokenRef;
      break;
    }
  }
  let tokens = ex.tokens;
  if (reuse && !tokens.refreshToken) {
    // Keep a refresh token the provider didn't resend (Google on re-consent).
    const old = await secrets.getJson<OAuthTokens>(reuse).catch(() => null);
    if (old?.refreshToken) tokens = { ...tokens, refreshToken: old.refreshToken };
  }
  let tokenRef: string;
  if (reuse) {
    await secrets.replace(reuse, JSON.stringify(tokens));
    tokenRef = reuse;
  } else {
    tokenRef = await secrets.put(userId, tokenKind(provider, 'read'), JSON.stringify(tokens));
  }
  const scopes = grantedScopes(tokens);

  const [user] = await db
    .select({ strictPersonal: users.strictPersonal })
    .from(users)
    .where(eq(users.id, userId));
  const out: string[] = [];
  const replacedRefs = new Set<string>();
  for (const identity of identities) {
    const { externalId } = identity;
    const prior = existing.find((r) => r.externalId === externalId);
    if (prior) {
      // Reconnect: point at the new secret; recorded scopes are replaced by this consent's.
      if (prior.tokenRef && prior.tokenRef !== tokenRef) replacedRefs.add(prior.tokenRef);
      const { grantedScopes: _old, ...kept } = objectOf(prior.meta);
      const meta = {
        ...kept,
        ...(identity.meta ?? {}),
        ...(scopes ? { grantedScopes: scopes } : {}),
      };
      const status = ['reconnect', 'disconnected'].includes(prior.status)
        ? 'connecting'
        : prior.status;
      await db
        .update(accounts)
        .set({ tokenRef, status, meta, routeKeys: identity.routeKeys ?? prior.routeKeys })
        .where(eq(accounts.id, prior.id));
      await ctx.audit({
        userId,
        principal: 'user',
        action: 'account.reconnected',
        target: `account:${prior.id}`,
        details: { provider, access: 'read' },
      });
      await ctx.live(userId, { type: 'account.updated', accountId: prior.id });
      out.push(prior.id);
      continue;
    }

    // The connector may know better than the address (Microsoft: consumer tenant id).
    const isPersonal =
      identity.meta?.personal === true ||
      isPersonalAddress(provider, externalId) ||
      isPersonalAddress(provider, String(identity.meta?.mail ?? ''));
    const base =
      workspaceName(provider, identity.displayName) ?? (isPersonal ? 'Personal' : 'Work');
    const [created] = await db
      .insert(accounts)
      .values({
        userId,
        provider,
        externalId,
        nickname: await defaultNickname(db, userId, provider, base),
        color: await nextColor(db, userId),
        status: 'connecting',
        isPersonal,
        tokenRef,
        meta: { ...(identity.meta ?? {}), ...(scopes ? { grantedScopes: scopes } : {}) },
        routeKeys: identity.routeKeys ?? [],
      })
      .onConflictDoNothing({ target: [accounts.userId, accounts.provider, accounts.externalId] })
      .returning();
    if (!created) continue; // lost a race with a parallel completion for the same account
    if (isPersonal && user?.strictPersonal) await applyStrictPolicies(db, userId, created.id, now);
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'account.connected',
      target: `account:${created.id}`,
      details: { provider, access: 'read', isPersonal, identities: identities.length },
    });
    await ctx.live(userId, { type: 'account.updated', accountId: created.id });
    out.push(created.id);
  }

  // Secrets no account points at any more (each was replaced by this consent's).
  for (const ref of replacedRefs) {
    if ((await secretUsers(db, ref, 'read')).length === 0) await secrets.delete(ref);
  }
  if (out.length === 0) {
    if ((await secretUsers(db, tokenRef, 'read')).length === 0) await secrets.delete(tokenRef);
    return { error: 'already_connected' };
  }
  return out;
}

/** Write-scope consent: stored separately in write_token_ref, used only by the executor. */
async function storeWriteTokens(
  ctx: Ctx,
  state: OAuthState,
  ex: ExchangeResult,
): Promise<string[] | { error: ConnectErrorCode }> {
  const { db, secrets } = ctx;
  if (!state.accountId) return { error: 'invalid_state' };
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, state.accountId), eq(accounts.userId, state.userId)));
  if (!account) return { error: 'account_not_found' };
  const target = account.externalId.toLowerCase();
  const match = identitiesOf(ex).find((i) => i.externalId.trim().toLowerCase() === target);
  if (!match) {
    // The user consented with a different identity than the one being upgraded.
    return { error: 'account_mismatch' };
  }
  // Some providers key accounts by a shared resource (an Atlassian site), not the person:
  // the write consent must also come from the same person as the read consent.
  const personKey = PERSON_KEY[account.provider];
  if (personKey) {
    const had = (account.meta as Record<string, unknown> | null)?.[personKey];
    const got = match.meta?.[personKey];
    if (typeof had !== 'string' || had !== got) return { error: 'account_mismatch' };
  }
  const value = JSON.stringify(ex.tokens);
  // Write access is granted to this account only, even if the consent covers others.
  if (
    account.writeTokenRef &&
    (await secretUsers(db, account.writeTokenRef, 'write', account.id)).length > 0
  ) {
    account.writeTokenRef = null; // shared with another account: give this one its own
  }
  if (account.writeTokenRef) await secrets.replace(account.writeTokenRef, value);
  const writeTokenRef =
    account.writeTokenRef ??
    (await secrets.put(state.userId, tokenKind(account.provider, 'write'), value));
  await db.update(accounts).set({ writeTokenRef }).where(eq(accounts.id, account.id));
  await ctx.audit({
    userId: state.userId,
    principal: 'user',
    action: 'account.write_access_granted',
    target: `account:${account.id}`,
    details: { provider: account.provider },
  });
  await ctx.live(state.userId, { type: 'account.updated', accountId: account.id });
  return [account.id];
}
