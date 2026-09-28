import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { audit, grants, mcpAuthCodes, mcpClients, mcpOauthClients, users, type Db } from '@hub/db';
import { hashToken, randomToken, safeEqual } from '@hub/server';
import type { Ctx } from '../deps';
import { REFRESH_STATE_KEY, type HubClientsStore, type StoredClient } from './clients';

export const HUB_SCOPE = 'hub';
const CODE_TTL_MS = 10 * 60 * 1000;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const DAY_MS = 24 * 3600 * 1000;
/** A refresh chain dies this long after the user approved the connection. */
export const REFRESH_MAX_AGE_MS = 90 * DAY_MS;
/** ...or after this long without any use (MCP requests or refreshes). */
export const REFRESH_IDLE_MS = 30 * DAY_MS;
/** Rotated-out refresh hashes remembered per client, for reuse detection. */
const PREVIOUS_KEPT = 5;

/**
 * Per mcp_clients row, in mcp_oauth_clients.metadata[REFRESH_STATE_KEY][mcpClientId].
 * Hashes only.
 */
type RefreshState = { authAt: string; refreshedAt?: string; prev: string[] };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
      const revoked = await this.revokeClient(
        and(eq(mcpClients.userId, row.userId), eq(mcpClients.oauthClientId, row.clientId)),
        now,
      );
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
    // A new approval starts a new refresh chain: fresh lifetime, no old hashes.
    await this.writeRefreshState(db, row.clientId, mcpClientId, {
      authAt: now.toISOString(),
      refreshedAt: now.toISOString(),
      prev: [],
    });
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

  /**
   * Refresh with rotation: the old refresh token and access token stop working.
   * The chain ends REFRESH_MAX_AGE_MS after the approval, or after REFRESH_IDLE_MS unused.
   * Presenting a token that was already rotated out revokes the connection.
   */
  async refresh(client: StoredClient, refreshToken: string): Promise<OAuthTokens> {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const oldHash = hashToken(refreshToken);
    const oauthClientId = client.client_id;
    const [row] = await db
      .select({
        id: mcpClients.id,
        userId: mcpClients.userId,
        createdAt: mcpClients.createdAt,
        lastUsedAt: mcpClients.lastUsedAt,
        revokedAt: mcpClients.revokedAt,
      })
      .from(mcpClients)
      .where(
        and(eq(mcpClients.refreshTokenHash, oldHash), eq(mcpClients.oauthClientId, oauthClientId)),
      );
    const states = await this.refreshStates(oauthClientId);
    if (!row) {
      const reused = Object.entries(states).find(([, st]) => st.prev?.includes(oldHash));
      if (reused) await this.revokeOnReuse(oauthClientId, reused[0], now, 'rotated_token');
      throw new InvalidGrantError('Invalid refresh token');
    }
    if (row.revokedAt) throw new InvalidGrantError('Invalid refresh token');

    const state = states[row.id];
    const authAt = state ? Date.parse(state.authAt) : row.createdAt.getTime();
    if (!(now.getTime() - authAt < REFRESH_MAX_AGE_MS)) {
      throw new InvalidGrantError('Refresh token expired; connect again');
    }
    const lastActive = Math.max(
      authAt,
      state?.refreshedAt ? Date.parse(state.refreshedAt) : 0,
      row.lastUsedAt?.getTime() ?? 0,
    );
    if (!(now.getTime() - lastActive < REFRESH_IDLE_MS)) {
      throw new InvalidGrantError('Refresh token expired after inactivity; connect again');
    }

    const access = `hub_at_${randomToken(32)}`;
    const refresh = `hub_rt_${randomToken(32)}`;
    const rotated = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(mcpClients)
        .set({
          tokenHash: hashToken(access),
          refreshTokenHash: hashToken(refresh),
          expiresAt: new Date(now.getTime() + this.ctx.accessTokenTtlSeconds * 1000),
        })
        .where(
          and(
            eq(mcpClients.id, row.id),
            eq(mcpClients.refreshTokenHash, oldHash),
            isNull(mcpClients.revokedAt),
          ),
        )
        .returning({ scopes: mcpClients.scopes });
      if (!r) return undefined;
      await this.writeRefreshState(tx, oauthClientId, row.id, {
        authAt: new Date(authAt).toISOString(),
        refreshedAt: now.toISOString(),
        prev: [oldHash, ...(state?.prev ?? [])].slice(0, PREVIOUS_KEPT),
      });
      return r;
    });
    if (!rotated) {
      // Someone else rotated this very token a moment ago: two holders, same token.
      await this.revokeOnReuse(oauthClientId, row.id, now, 'concurrent_use');
      throw new InvalidGrantError('Invalid refresh token');
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.ctx.accessTokenTtlSeconds,
      refresh_token: refresh,
      scope: (rotated.scopes as string[]).join(' '),
    };
  }

  /** RFC 7009: revoking either token disconnects the client. Unknown tokens are a no-op. */
  async revoke(client: StoredClient, token: string): Promise<void> {
    const { db } = this.ctx;
    const h = hashToken(token);
    for (const col of [mcpClients.tokenHash, mcpClients.refreshTokenHash]) {
      // Also ends the client's temporary grants, as revoking on the phone does.
      const rows = await this.revokeClient(
        and(eq(col, h), eq(mcpClients.oauthClientId, client.client_id)),
        this.ctx.now(),
      );
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

  private async refreshStates(oauthClientId: string): Promise<Record<string, RefreshState>> {
    const [row] = await this.ctx.db
      .select({ metadata: mcpOauthClients.metadata })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, oauthClientId));
    const all = (row?.metadata as Record<string, unknown> | undefined)?.[REFRESH_STATE_KEY];
    return all && typeof all === 'object' ? (all as Record<string, RefreshState>) : {};
  }

  /** Atomic per-key merge, so concurrent writers for other mcp_clients rows don't clobber. */
  private async writeRefreshState(
    db: Db | Tx,
    oauthClientId: string,
    mcpClientId: string,
    state: RefreshState,
  ) {
    const m = mcpOauthClients.metadata;
    await db
      .update(mcpOauthClients)
      .set({
        metadata: sql`jsonb_set(${m}, ${sql.raw(`'{${REFRESH_STATE_KEY}}'`)}, coalesce(${m}->${sql.raw(`'${REFRESH_STATE_KEY}'`)}, '{}'::jsonb) || jsonb_build_object(${mcpClientId}::text, ${JSON.stringify(state)}::jsonb))`,
      })
      .where(eq(mcpOauthClients.clientId, oauthClientId));
  }

  /**
   * Disconnects an mcp_clients row and ends its temporary grants, like the phone's
   * DELETE /mcp/clients/:id. Returns the rows it revoked.
   */
  private async revokeClient(
    where: ReturnType<typeof and>,
    now: Date,
  ): Promise<{ id: string; userId: string }[]> {
    const { db } = this.ctx;
    const rows = await db
      .update(mcpClients)
      .set({ revokedAt: now })
      .where(and(where, isNull(mcpClients.revokedAt)))
      .returning({ id: mcpClients.id, userId: mcpClients.userId });
    for (const r of rows) {
      await db
        .update(grants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(grants.userId, r.userId),
            eq(grants.principal, `mcp:${r.id}`),
            isNull(grants.revokedAt),
          ),
        );
    }
    return rows;
  }

  /**
   * A refresh token that was already rotated out came back: either the client or a thief
   * holds a stale copy, and we can't tell which. Revoke the whole connection.
   */
  private async revokeOnReuse(
    oauthClientId: string,
    mcpClientId: string,
    now: Date,
    how: 'rotated_token' | 'concurrent_use',
  ) {
    const rows = await this.revokeClient(
      and(eq(mcpClients.id, mcpClientId), eq(mcpClients.oauthClientId, oauthClientId)),
      now,
    );
    for (const r of rows) {
      await audit(this.ctx.db, {
        userId: r.userId,
        principal: 'system:mcp',
        action: 'mcp.token.refresh_reuse',
        target: r.id,
        details: { oauthClientId, how },
      });
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
