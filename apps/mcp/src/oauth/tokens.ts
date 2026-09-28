import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { audit, mcpAuthCodes, mcpClients, users } from '@hub/db';
import { hashToken, randomToken, safeEqual } from '@hub/server';
import type { Ctx } from '../deps';
import type { HubClientsStore, StoredClient } from './clients';

export const HUB_SCOPE = 'hub';
const CODE_TTL_MS = 10 * 60 * 1000;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** What the MCP endpoint knows about the caller after bearer auth. */
export type McpAuthExtra = { userId: string; mcpClientId: string; clientName: string };

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Only the scopes we know; the policy engine, not scopes, decides what a client sees. */
export function normalizeScopes(_requested: string[] | undefined): string[] {
  return [HUB_SCOPE];
}

export class HubTokens implements OAuthTokenVerifier {
  constructor(
    private readonly ctx: Ctx,
    private readonly clients: HubClientsStore,
  ) {}

  /**
   * Client authentication for /token and /revoke: client_secret_post, client_secret_basic,
   * or none for public clients (PKCE carries the proof).
   */
  async authenticateClient(
    body: Record<string, unknown>,
    authorization: string | undefined,
  ): Promise<StoredClient> {
    let clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    let secret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
    if (authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        clientId = decodeURIComponent(decoded.slice(0, i));
        secret = decodeURIComponent(decoded.slice(i + 1));
      }
    }
    if (!clientId) throw new InvalidRequestError('client_id is required');
    const client = await this.clients.getStored(clientId);
    if (!client) throw new InvalidClientError('Invalid client');
    if (client.secretHash) {
      if (!secret || !safeEqual(hashToken(secret), client.secretHash)) {
        throw new InvalidClientError('Invalid client');
      }
      const exp = client.client_secret_expires_at;
      if (exp && exp > 0 && exp < Math.floor(this.ctx.now().getTime() / 1000)) {
        throw new InvalidClientError('Client secret has expired');
      }
    }
    return client;
  }

  /** One-time code, 10-minute expiry, stored as a hash. Returns the plaintext code. */
  async issueCode(input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
  }): Promise<string> {
    const code = `hub_ac_${randomToken(32)}`;
    await this.ctx.db.insert(mcpAuthCodes).values({
      codeHash: hashToken(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      expiresAt: new Date(this.ctx.now().getTime() + CODE_TTL_MS),
    });
    return code;
  }

  async exchangeCode(
    client: StoredClient,
    params: { code: string; codeVerifier: string; redirectUri?: string },
  ): Promise<OAuthTokens> {
    const { db } = this.ctx;
    const now = this.ctx.now();
    if (!VERIFIER_RE.test(params.codeVerifier)) {
      throw new InvalidGrantError('code_verifier is malformed');
    }
    const codeHash = hashToken(params.code);
    const [row] = await db.select().from(mcpAuthCodes).where(eq(mcpAuthCodes.codeHash, codeHash));
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (row.usedAt) {
      // Replay: OAuth 2.1 says revoke what the code produced.
      const revoked = await db
        .update(mcpClients)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mcpClients.userId, row.userId),
            eq(mcpClients.oauthClientId, row.clientId),
            isNull(mcpClients.revokedAt),
          ),
        )
        .returning({ id: mcpClients.id });
      await audit(db, {
        userId: row.userId,
        principal: 'system:mcp',
        action: 'mcp.token.code_reuse',
        target: row.id,
        details: { oauthClientId: row.clientId, revokedClients: revoked.map((r) => r.id) },
      });
      throw new InvalidGrantError('Authorization code was already used');
    }
    if (row.expiresAt <= now) throw new InvalidGrantError('Authorization code expired');
    if (params.redirectUri !== undefined && params.redirectUri !== row.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match');
    }
    if (!safeEqual(pkceS256(params.codeVerifier), row.codeChallenge)) {
      throw new InvalidGrantError('code_verifier does not match the challenge');
    }
    const [consumed] = await db
      .update(mcpAuthCodes)
      .set({ usedAt: now })
      .where(and(eq(mcpAuthCodes.id, row.id), isNull(mcpAuthCodes.usedAt)))
      .returning({ id: mcpAuthCodes.id });
    if (!consumed) throw new InvalidGrantError('Authorization code was already used');

    const access = `hub_at_${randomToken(32)}`;
    const refresh = `hub_rt_${randomToken(32)}`;
    const expiresAt = new Date(now.getTime() + this.ctx.accessTokenTtlSeconds * 1000);
    const scopes = row.scopes as string[];
    const values = {
      name: client.client_name ?? 'MCP client',
      tokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      scopes,
      expiresAt,
    };
    // One live row per (user, OAuth client); a revoked row stays revoked as history.
    const [existing] = await db
      .select({ id: mcpClients.id })
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.userId, row.userId),
          eq(mcpClients.oauthClientId, row.clientId),
          isNull(mcpClients.revokedAt),
        ),
      );
    let mcpClientId: string;
    if (existing) {
      await db.update(mcpClients).set(values).where(eq(mcpClients.id, existing.id));
      mcpClientId = existing.id;
    } else {
      const [created] = await db
        .insert(mcpClients)
        .values({ ...values, userId: row.userId, oauthClientId: row.clientId })
        .returning({ id: mcpClients.id });
      mcpClientId = created!.id;
    }
    await audit(db, {
      userId: row.userId,
      principal: `mcp:${mcpClientId}`,
      action: 'mcp.client.connected',
      target: mcpClientId,
      details: { oauthClientId: row.clientId, authCodeId: row.id, reconnected: !!existing },
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.ctx.accessTokenTtlSeconds,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  /** Refresh with rotation: the old refresh token and access token stop working. */
  async refresh(client: StoredClient, refreshToken: string): Promise<OAuthTokens> {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const oldHash = hashToken(refreshToken);
    const access = `hub_at_${randomToken(32)}`;
    const refresh = `hub_rt_${randomToken(32)}`;
    const [row] = await db
      .update(mcpClients)
      .set({
        tokenHash: hashToken(access),
        refreshTokenHash: hashToken(refresh),
        expiresAt: new Date(now.getTime() + this.ctx.accessTokenTtlSeconds * 1000),
      })
      .where(
        and(
          eq(mcpClients.refreshTokenHash, oldHash),
          eq(mcpClients.oauthClientId, client.client_id),
          isNull(mcpClients.revokedAt),
        ),
      )
      .returning({ id: mcpClients.id, scopes: mcpClients.scopes });
    if (!row) throw new InvalidGrantError('Invalid refresh token');
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.ctx.accessTokenTtlSeconds,
      refresh_token: refresh,
      scope: (row.scopes as string[]).join(' '),
    };
  }

  /** RFC 7009: revoking either token disconnects the client. Unknown tokens are a no-op. */
  async revoke(client: StoredClient, token: string): Promise<void> {
    const { db } = this.ctx;
    const h = hashToken(token);
    for (const col of [mcpClients.tokenHash, mcpClients.refreshTokenHash]) {
      const rows = await db
        .update(mcpClients)
        .set({ revokedAt: this.ctx.now() })
        .where(
          and(
            eq(col, h),
            eq(mcpClients.oauthClientId, client.client_id),
            isNull(mcpClients.revokedAt),
          ),
        )
        .returning({ id: mcpClients.id, userId: mcpClients.userId });
      for (const r of rows) {
        await audit(db, {
          userId: r.userId,
          principal: `mcp:${r.id}`,
          action: 'mcp.client.revoked',
          target: r.id,
          details: { via: 'oauth_revoke' },
        });
      }
      if (rows.length) return;
    }
  }

  /** Called on every /mcp request. Revoked or expired tokens are rejected. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const [row] = await db
      .select({
        id: mcpClients.id,
        userId: mcpClients.userId,
        name: mcpClients.name,
        oauthClientId: mcpClients.oauthClientId,
        scopes: mcpClients.scopes,
        expiresAt: mcpClients.expiresAt,
        revokedAt: mcpClients.revokedAt,
        userExists: users.id,
      })
      .from(mcpClients)
      .innerJoin(users, eq(users.id, mcpClients.userId))
      .where(eq(mcpClients.tokenHash, hashToken(token)));
    if (!row || row.revokedAt) throw new InvalidTokenError('Invalid access token');
    if (!row.expiresAt || row.expiresAt <= now) throw new InvalidTokenError('Access token expired');
    await db.update(mcpClients).set({ lastUsedAt: now }).where(eq(mcpClients.id, row.id));
    const extra: McpAuthExtra = { userId: row.userId, mcpClientId: row.id, clientName: row.name };
    return {
      token,
      clientId: row.oauthClientId ?? row.id,
      scopes: row.scopes as string[],
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      extra,
    };
  }
}
