import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Connector, OAuthTokens } from '@hub/connectors';
import { accounts, users, type Db } from '@hub/db';
import { ACCOUNT_COLORS, AccountFilters, Provider, type Account } from '@hub/shared';
import { ConnectReq, UpdateAccountReq } from '@hub/shared/api';

type ConnectRes = { url: string };
import { QUEUES } from '@hub/shared/queues';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, HttpError, idParam, parse } from '../http';
import {
  CALLBACK_NAME,
  callbackUrl,
  checkAppRedirect,
  defaultAppRedirect,
  signState,
  verifyState,
  withQuery,
  type OAuthState,
} from '../oauth-state';
import { accountFilters, toAccount } from '../serialize';
import { applyStrictPolicies, syncStrictPolicies } from '../strict';
import { sentKeys } from './me';

type AccountRow = typeof accounts.$inferSelect;

const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function lookupConnector(ctx: Ctx, provider: Provider): Connector {
  let c: Connector | undefined;
  try {
    c = ctx.getConnector(provider);
  } catch {
    c = undefined;
  }
  if (!c) throw new HttpError(400, 'unsupported_provider', `${provider} is not supported yet`);
  return c;
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

function isPersonalAddress(provider: string, externalId: string): boolean {
  if (provider !== 'gmail') return false;
  const domain = externalId.split('@')[1]?.toLowerCase();
  return domain !== undefined && PERSONAL_DOMAINS.has(domain);
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
  if (patch.filters !== undefined) {
    set.filters = AccountFilters.parse({ ...accountFilters(account.filters), ...patch.filters });
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
      details: { fields: Object.keys(set), ...(backfill ? { backfillDays: backfill } : {}) },
    });
    await ctx.live(account.userId, { type: 'account.updated', accountId: account.id });
  }
  return updated;
}

const ProviderParam = z.object({ provider: Provider });
const CallbackParam = z.object({ name: z.string() });
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
        loginHint: account.externalId,
      }),
    };
  });

  app.get('/oauth/:name/callback', async (req, reply) => {
    const { name } = parse(CallbackParam, req.params);
    const q = parse(CallbackQuery, req.query);
    const state = q.state ? await verifyState(config, q.state, ctx.now()) : null;
    if (!state || CALLBACK_NAME[state.provider] !== name) {
      throw new HttpError(400, 'invalid_state', 'OAuth state is missing, invalid or expired');
    }
    const back = state.redirect ?? defaultAppRedirect(config);
    const fail = async (error: string) => {
      await ctx.audit({
        userId: state.userId,
        principal: 'user',
        action: 'account.connect_failed',
        details: { provider: state.provider, access: state.access, error },
      });
      return reply.redirect(
        withQuery(back, { error, ...(state.accountId ? { accountId: state.accountId } : {}) }),
        302,
      );
    };

    if (q.error) return fail(q.error === 'access_denied' ? 'access_denied' : 'oauth_error');
    if (!q.code) return fail('missing_code');

    const connector = lookupConnector(ctx, state.provider);
    let exchanged: Awaited<ReturnType<Connector['connect']['exchange']>>;
    try {
      exchanged = await connector.connect.exchange({
        code: q.code,
        redirectUri: callbackUrl(config, state.provider),
      });
    } catch (err) {
      ctx.warn('oauth exchange failed', { provider: state.provider, err: (err as Error).message });
      return fail('exchange_failed');
    }

    const accountId =
      state.access === 'write'
        ? await storeWriteTokens(ctx, state, exchanged)
        : await storeReadTokens(ctx, state, exchanged);
    if (typeof accountId !== 'string') return fail(accountId.error);
    return reply.redirect(withQuery(back, { accountId }), 302);
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
    const refs = [account.tokenRef, account.writeTokenRef].filter((r): r is string => !!r);

    // Best effort: revoke at the provider first; a failure never blocks deletion.
    let revoked = false;
    try {
      const connector = ctx.getConnector(account.provider as Provider);
      if (connector) {
        for (const ref of refs) {
          const tokens = await secrets.getJson<OAuthTokens>(ref);
          await connector.connect.revoke(tokens);
        }
        revoked = refs.length > 0;
      }
    } catch (err) {
      ctx.warn('token revoke failed', { provider: account.provider, err: (err as Error).message });
    }

    await db.delete(accounts).where(and(eq(accounts.id, account.id), eq(accounts.userId, userId)));
    for (const ref of refs) await secrets.delete(ref);
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'account.deleted',
      target: `account:${account.id}`,
      details: { provider: account.provider, revoked },
    });
    await ctx.live(userId, { type: 'account.updated', accountId: account.id });
    return reply.code(204).send();
  });
}

type Exchanged = { tokens: OAuthTokens; externalId: string; displayName: string | null };

/** Read-scope consent: create or refresh the account. Returns the account id. */
async function storeReadTokens(
  ctx: Ctx,
  state: OAuthState,
  ex: Exchanged,
): Promise<string | { error: string }> {
  const { db, secrets } = ctx;
  const { userId, provider } = state;
  // Stored as the connector returns it: the gateway maps webhook identities to it verbatim.
  const externalId = ex.externalId.trim();
  const now = ctx.now();

  const [existing] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, provider),
        eq(accounts.externalId, externalId),
      ),
    );

  if (existing) {
    // Reconnect: rotate the stored tokens, keeping a refresh token Google didn't resend.
    let tokens = ex.tokens;
    if (existing.tokenRef) {
      if (!tokens.refreshToken) {
        const old = await secrets.getJson<OAuthTokens>(existing.tokenRef).catch(() => null);
        if (old?.refreshToken) tokens = { ...tokens, refreshToken: old.refreshToken };
      }
      await secrets.replace(existing.tokenRef, JSON.stringify(tokens));
    }
    const tokenRef =
      existing.tokenRef ??
      (await secrets.put(userId, tokenKind(provider, 'read'), JSON.stringify(tokens)));
    const status = ['reconnect', 'disconnected'].includes(existing.status)
      ? 'connecting'
      : existing.status;
    await db.update(accounts).set({ tokenRef, status }).where(eq(accounts.id, existing.id));
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'account.reconnected',
      target: `account:${existing.id}`,
      details: { provider, access: 'read' },
    });
    await ctx.live(userId, { type: 'account.updated', accountId: existing.id });
    return existing.id;
  }

  const tokenRef = await secrets.put(
    userId,
    tokenKind(provider, 'read'),
    JSON.stringify(ex.tokens),
  );
  const isPersonal = isPersonalAddress(provider, externalId);
  const [created] = await db
    .insert(accounts)
    .values({
      userId,
      provider,
      externalId,
      nickname: await defaultNickname(db, userId, provider, isPersonal ? 'Personal' : 'Work'),
      color: await nextColor(db, userId),
      status: 'connecting',
      isPersonal,
      tokenRef,
    })
    .onConflictDoNothing({ target: [accounts.userId, accounts.provider, accounts.externalId] })
    .returning();
  if (!created) {
    // Lost a race with a parallel callback for the same account.
    await secrets.delete(tokenRef);
    return { error: 'already_connected' };
  }

  const [user] = await db
    .select({ strictPersonal: users.strictPersonal })
    .from(users)
    .where(eq(users.id, userId));
  if (isPersonal && user?.strictPersonal) await applyStrictPolicies(db, userId, created.id, now);

  await ctx.audit({
    userId,
    principal: 'user',
    action: 'account.connected',
    target: `account:${created.id}`,
    details: { provider, access: 'read', isPersonal },
  });
  await ctx.live(userId, { type: 'account.updated', accountId: created.id });
  return created.id;
}

/** Write-scope consent: stored separately in write_token_ref, used only by the executor. */
async function storeWriteTokens(
  ctx: Ctx,
  state: OAuthState,
  ex: Exchanged,
): Promise<string | { error: string }> {
  const { db, secrets } = ctx;
  if (!state.accountId) return { error: 'invalid_state' };
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, state.accountId), eq(accounts.userId, state.userId)));
  if (!account) return { error: 'account_not_found' };
  if (account.externalId.toLowerCase() !== ex.externalId.trim().toLowerCase()) {
    // The user consented with a different Google account than the one being upgraded.
    return { error: 'account_mismatch' };
  }
  const value = JSON.stringify(ex.tokens);
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
  return account.id;
}
