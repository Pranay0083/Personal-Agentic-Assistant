import { ConnectorError, MissingScopeError, ReconnectRequiredError } from '../errors';
import { authorizeUrl, exchangeCode, toTokens, type TokenResponse } from '../lib/index';
import type { AccessKind, ConnectorContext, ExchangeResult } from '../types';
import {
  IDENTITY_SCOPES,
  MSA_TENANT_ID,
  authorizeEndpoint,
  clientFor,
  isWriteScope,
  normalizeScopes,
  scopesFor,
  tokenUrl,
  type MicrosoftConfig,
} from './config';
import { graphFor, PROVIDER } from './graph';
import type { GraphUser } from './graph-types';

export function msAuthUrl(
  cfg: MicrosoftConfig,
  o: { state: string; redirectUri: string; access: AccessKind; loginHint?: string },
): string {
  const { clientId } = clientFor(cfg, o.access);
  return authorizeUrl(
    { authorizeUrl: authorizeEndpoint(cfg), clientId },
    {
      state: o.state,
      redirectUri: o.redirectUri,
      scopes: scopesFor(cfg, o.access),
      extra: {
        response_mode: 'query',
        // Lets the user pick (or add) the right account: several per person are expected.
        prompt: 'select_account',
        ...(o.loginHint ? { login_hint: o.loginHint } : {}),
      },
    },
  );
}

/**
 * Checks what the consent actually granted. Read: User.Read is required (identity); the
 * data scopes are optional per source (enabledSources turns off what wasn't granted), and
 * any write scope is refused. Write: Mail.Send is required.
 */
export function checkGrant(granted: string[], access: AccessKind, hasRefreshToken: boolean) {
  const has = (s: string) => granted.some((g) => g.toLowerCase() === s.toLowerCase());
  if (access === 'read') {
    const writes = granted.filter((s) => !IDENTITY_SCOPES.has(s.toLowerCase()) && isWriteScope(s));
    if (writes.length) {
      // Usually a Mail.Send consent given earlier to the same app: Microsoft adds every
      // consented scope to the app's tokens. Configure MS_WRITE_CLIENT_ID to separate them.
      throw new ConnectorError(PROVIDER, 'read grant unexpectedly includes write scopes', {
        status: 400,
      });
    }
    if (!has('User.Read')) throw new MissingScopeError(PROVIDER, ['User.Read']);
    if (!hasRefreshToken) throw new MissingScopeError(PROVIDER, ['offline_access']);
    return;
  }
  if (!has('Mail.Send')) throw new MissingScopeError(PROVIDER, ['Mail.Send']);
}

/**
 * Claims of the id_token. It comes straight from the token endpoint over TLS, which OIDC
 * accepts in place of signature validation; we only read `tid` from it.
 */
export function idTokenClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== 'string') return {};
  const part = idToken.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Personal accounts: the MSA tenant id, or (no id_token) Graph's 16-hex-digit user ids. */
export function isPersonalAccount(tenantId: string | null, userId: string): boolean {
  if (tenantId) return tenantId.toLowerCase() === MSA_TENANT_ID;
  return /^[0-9a-f]{16}$/i.test(userId);
}

export async function msExchange(
  cfg: MicrosoftConfig,
  o: { code: string; redirectUri: string; access?: AccessKind },
): Promise<ExchangeResult> {
  const access = o.access ?? 'read';
  const { clientId, clientSecret } = clientFor(cfg, access);
  let res: TokenResponse;
  try {
    res = await exchangeCode(
      {
        provider: PROVIDER,
        authorizeUrl: authorizeEndpoint(cfg),
        tokenUrl: tokenUrl(cfg),
        clientId,
        clientSecret,
        ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
      },
      {
        code: o.code,
        redirectUri: o.redirectUri,
        extra: { scope: scopesFor(cfg, access).join(' ') },
      },
    );
  } catch (e) {
    // A bad or reused code is a failed connect, not a revoked account.
    if (e instanceof ReconnectRequiredError) {
      throw new ConnectorError(PROVIDER, 'oauth code exchange failed', { status: 400 });
    }
    throw e;
  }
  const tokens = toTokens(res, cfg.now?.() ?? Date.now());
  const grantedScopes = normalizeScopes(res.scope);
  if (o.access) checkGrant(grantedScopes, o.access, !!tokens.refreshToken);

  const ctx: ConnectorContext = {
    accountId: '',
    externalId: '',
    tokens,
    saveTokens: async () => {},
    cursor: null,
    filters: { inbox: true, sent: true, promotions: false, labels: [], sources: {}, options: {} },
  };
  const me = await graphFor(cfg, ctx, access).request<GraphUser>('/me', {
    query: { $select: 'id,displayName,userPrincipalName,mail' },
  });
  if (!me?.id) throw new ConnectorError(PROVIDER, 'could not read the signed-in user');
  const claims = idTokenClaims(res.id_token);
  const tenantId = typeof claims.tid === 'string' ? claims.tid : null;
  const personal = isPersonalAccount(tenantId, me.id);
  const upn = me.userPrincipalName ?? null;
  const mail = me.mail ?? null;
  const displayName = upn ?? mail ?? me.displayName ?? null;
  const meta = {
    tenantId: tenantId ?? (personal ? MSA_TENANT_ID : null),
    upn,
    mail,
    name: me.displayName ?? null,
    personal,
    grantedScopes,
    // Graph has no chat APIs for personal accounts.
    ...(personal ? { unavailableSources: ['teams', 'channels'] } : {}),
  };
  return {
    tokens,
    externalId: me.id,
    displayName,
    identities: [{ externalId: me.id, displayName, meta }],
  };
}
