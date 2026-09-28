import { and, eq, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { accessRequests, audit, mcpOauthClients, users } from '@hub/db';
import { hashToken, randomToken } from '@hub/server';
import { QUEUES, type NotifierJob } from '@hub/shared/queues';
import type { Ctx } from '../deps';
import { RateLimiter } from '../rate-limit';
import type { HubClientsStore } from './clients';
import { consentPage, waitingPage } from './pages';
import { normalizeScopes, type HubTokens } from './tokens';

/** Pending authorization stored in access_requests.meta for kind `mcp_connect`. */
export type ConnectMeta = {
  oauthClientId: string;
  redirectUri: string;
  redirectHost: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  pollTokenHash: string;
  codeIssuedAt?: string;
};

const Email = z.email().max(254);

export function resourceMatches(resource: URL, publicUrl: string): boolean {
  const strip = (s: string) => s.replace(/#.*$/, '').replace(/\/+$/, '');
  const ours = new URL(publicUrl);
  return strip(resource.href) === strip(ours.href) || strip(resource.href) === strip(ours.origin);
}

function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return 'your app';
  }
}

/**
 * The part of the OAuth flow where the user proves who they are: an email on a web
 * page, then an approval on their phone. Unknown emails get the same page and the same
 * status answers as real ones, so the page never reveals whether an account exists.
 */
export class ConsentFlow {
  private readonly perIp: RateLimiter;
  private readonly perEmail: RateLimiter;
  private readonly statusPerIp: RateLimiter;
  /** Poll tokens handed out for emails without an account: hash → created ms. */
  private readonly decoys = new Map<string, number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly clients: HubClientsStore,
    private readonly tokens: HubTokens,
  ) {
    const rl = ctx.rateLimits;
    this.perIp = new RateLimiter(rl.consentPerIp, rl.windowMs, ctx.now);
    this.perEmail = new RateLimiter(rl.consentPerEmail, rl.windowMs, ctx.now);
    this.statusPerIp = new RateLimiter(rl.statusPerIp, rl.windowMs, ctx.now);
  }

  private get issuer() {
    return new URL(this.ctx.publicUrl).origin;
  }

  /** Minimal provider for the SDK's authorizationHandler, which validates the request first. */
  asProvider(): OAuthServerProvider {
    const notHere = async (): Promise<never> => {
      throw new Error('handled by the Hub token endpoint');
    };
    return {
      clientsStore: this.clients,
      authorize: (client, params, res) => this.authorize(client, params, res),
      challengeForAuthorizationCode: notHere,
      exchangeAuthorizationCode: notHere,
      exchangeRefreshToken: notHere,
      verifyAccessToken: (t) => this.tokens.verifyAccessToken(t),
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && !resourceMatches(params.resource, this.ctx.publicUrl)) {
      throw new InvalidTargetError('resource is not this MCP server');
    }
    const req = res.req as Request;
    const clientName = client.client_name ?? 'MCP client';
    const host = redirectHost(params.redirectUri);
    const fields = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      scope: params.scopes?.join(' '),
      state: params.state,
      resource: params.resource?.href,
    };
    const action = new URL('/authorize', this.issuer).href;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.method !== 'POST' || typeof body.hub_email !== 'string') {
      consentPage(res, { action, clientName, redirectHost: host, fields });
      return;
    }

    const parsed = Email.safeParse(body.hub_email.trim().toLowerCase());
    const ipOk = this.perIp.take(req.ip ?? 'unknown');
    const emailOk = parsed.success ? this.perEmail.take(parsed.data) : true;
    if (!ipOk || !emailOk) {
      consentPage(res, {
        action,
        clientName,
        redirectHost: host,
        fields,
        error: 'Too many attempts. Wait a few minutes and try again.',
      });
      return;
    }
    if (!parsed.success) {
      consentPage(res, { action, clientName, redirectHost: host, fields });
      return;
    }

    const pollToken = randomToken(32);
    const pollTokenHash = hashToken(pollToken);
    const [user] = await this.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${parsed.data}`);
    if (user) {
      const meta: ConnectMeta = {
        oauthClientId: client.client_id,
        redirectUri: params.redirectUri,
        redirectHost: host,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: normalizeScopes(params.scopes),
        resource: params.resource?.href,
        pollTokenHash,
      };
      await this.createConnectRequest(user.id, clientName, meta);
    } else {
      this.rememberDecoy(pollTokenHash);
    }
    waitingPage(res, {
      clientName,
      redirectHost: host,
      statusUrl: new URL('/authorize/status', this.issuer).href,
      pollToken,
    });
  }

  private async createConnectRequest(userId: string, clientName: string, meta: ConnectMeta) {
    const { db } = this.ctx;
    const [row] = await db
      .insert(accessRequests)
      .values({
        userId,
        kind: 'mcp_connect',
        principal: 'mcp:pending',
        clientName,
        resource: '*',
        level: 'read',
        meta,
      })
      .returning({ id: accessRequests.id });
    const id = row!.id;
    await audit(db, {
      userId,
      principal: 'mcp:pending',
      action: 'mcp.connect.requested',
      target: id,
      details: { oauthClientId: meta.oauthClientId },
    });
    const job: NotifierJob = {
      userId,
      kind: 'access_request',
      title: `Connect ${clientName}?`,
      body: `${clientName} wants to connect to Hub. Only allow it if you just tried to connect.`,
      data: { requestId: id },
      dedupeKey: `access_request:${id}`,
    };
    await this.ctx.enqueue(QUEUES.notifier, job, { jobId: `access_request-${id}` });
    await this.ctx.publishLive(userId, { type: 'access_request.created', requestId: id });
  }

  private rememberDecoy(hash: string) {
    const t = this.ctx.now().getTime();
    if (this.decoys.size > 10_000) {
      for (const [k, v] of this.decoys) {
        if (v + this.ctx.connectRequestTtlMs < t) this.decoys.delete(k);
      }
    }
    this.decoys.set(hash, t);
  }

  /** POST /authorize/status { t } — the waiting page polls this. */
  async status(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!this.statusPerIp.take(req.ip ?? 'unknown')) {
      res.status(429).json({ status: 'pending' });
      return;
    }
    const t = (req.body as Record<string, unknown> | undefined)?.t;
    if (typeof t !== 'string' || t.length < 20 || t.length > 100) {
      res.status(400).json({ status: 'expired' });
      return;
    }
    res.json(await this.check(hashToken(t)));
  }

  private async check(
    pollTokenHash: string,
  ): Promise<{ status: 'pending' | 'allowed' | 'denied' | 'expired' | 'used'; redirect?: string }> {
    const { db } = this.ctx;
    const now = this.ctx.now();
    const [row] = await db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.kind, 'mcp_connect'),
          sql`${accessRequests.meta}->>'pollTokenHash' = ${pollTokenHash}`,
        ),
      );
    if (!row) {
      const created = this.decoys.get(pollTokenHash);
      if (created !== undefined && created + this.ctx.connectRequestTtlMs > now.getTime()) {
        return { status: 'pending' };
      }
      return { status: 'expired' };
    }
    const expired = row.createdAt.getTime() + this.ctx.connectRequestTtlMs <= now.getTime();
    if (row.status === 'pending') {
      if (!expired) return { status: 'pending' };
      await db
        .update(accessRequests)
        .set({ status: 'expired', decidedAt: now })
        .where(and(eq(accessRequests.id, row.id), eq(accessRequests.status, 'pending')));
      return { status: 'expired' };
    }
    if (row.status === 'denied') return { status: 'denied' };
    if (row.status !== 'allowed') return { status: 'expired' };

    // Allowed: hand out exactly one code, however many times the page polls.
    const [claimed] = await db
      .update(accessRequests)
      .set({
        meta: sql`${accessRequests.meta} || ${JSON.stringify({ codeIssuedAt: now.toISOString() })}::jsonb`,
      })
      .where(
        and(
          eq(accessRequests.id, row.id),
          eq(accessRequests.status, 'allowed'),
          sql`NOT (${accessRequests.meta} ? 'codeIssuedAt')`,
        ),
      )
      .returning({ id: accessRequests.id });
    if (!claimed) return { status: 'used' };

    const meta = row.meta as ConnectMeta;
    const [client] = await db
      .select({ id: mcpOauthClients.clientId })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, meta.oauthClientId));
    if (!client) return { status: 'expired' };
    const code = await this.tokens.issueCode({
      clientId: meta.oauthClientId,
      userId: row.userId,
      redirectUri: meta.redirectUri,
      codeChallenge: meta.codeChallenge,
      scopes: meta.scopes,
    });
    await audit(db, {
      userId: row.userId,
      principal: 'mcp:pending',
      action: 'mcp.connect.code_issued',
      target: row.id,
      details: { oauthClientId: meta.oauthClientId },
    });
    const redirect = new URL(meta.redirectUri);
    redirect.searchParams.set('code', code);
    if (meta.state) redirect.searchParams.set('state', meta.state);
    return { status: 'allowed', redirect: redirect.href };
  }
}
