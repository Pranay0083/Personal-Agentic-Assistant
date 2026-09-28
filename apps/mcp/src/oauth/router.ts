import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  InvalidClientError,
  InvalidRequestError,
  InvalidTargetError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
  UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Ctx } from '../deps';
import { errorFields } from '../log';
import { RateLimiter } from '../rate-limit';
import { HubClientsStore } from './clients';
import { ConsentFlow, resourceMatches } from './consent';
import { HUB_SCOPE, HubTokens } from './tokens';

export function oauthMetadata(publicUrl: string): OAuthMetadata {
  const issuer = new URL('/', publicUrl);
  const at = (p: string) => new URL(p, issuer).href;
  return {
    issuer: issuer.href,
    authorization_endpoint: at('/authorize'),
    token_endpoint: at('/token'),
    registration_endpoint: at('/register'),
    revocation_endpoint: at('/revoke'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_post',
      'client_secret_basic',
    ],
    scopes_supported: [HUB_SCOPE],
  };
}

function sendOAuthError(res: Response, error: unknown) {
  const e = error instanceof OAuthError ? error : new ServerError('Internal Server Error');
  const status =
    e instanceof ServerError
      ? 500
      : e instanceof InvalidClientError
        ? 401
        : e instanceof TooManyRequestsError
          ? 429
          : 400;
  res.status(status).json(e.toResponseObject());
}

const CodeGrant = z.object({
  code: z.string().min(1).max(200),
  code_verifier: z.string().min(1).max(200),
  redirect_uri: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
});
const RefreshGrant = z.object({
  refresh_token: z.string().min(1).max(200),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
});

export type OAuthParts = { router: Router; tokens: HubTokens; clients: HubClientsStore };

/**
 * OAuth 2.1 authorization server for MCP clients. The SDK supplies metadata, dynamic
 * registration and authorize-request validation; token issuance is ours so that client
 * secrets and tokens are only ever stored as hashes.
 */
export function oauthRouter(ctx: Ctx): OAuthParts {
  const clients = new HubClientsStore(ctx.db);
  const tokens = new HubTokens(ctx, clients);
  const consent = new ConsentFlow(ctx, clients, tokens);
  const metadata = oauthMetadata(ctx.publicUrl);
  const router = express.Router();

  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl: new URL(ctx.publicUrl),
      resourceName: 'Hub',
      scopesSupported: [HUB_SCOPE],
    }),
  );
  // Some clients probe the root well-known path before the path-specific one.
  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      resource: new URL(ctx.publicUrl).href,
      authorization_servers: [metadata.issuer],
      scopes_supported: [HUB_SCOPE],
      resource_name: 'Hub',
    });
  });

  router.use(
    '/register',
    clientRegistrationHandler({
      clientsStore: clients,
      // 0 = secrets never expire (RFC 7591); a connector should not break after 30 days.
      clientSecretExpirySeconds: 0,
    }),
  );

  router.post('/authorize/status', express.json({ limit: '4kb' }), (req, res, next) => {
    consent.status(req, res).catch(next);
  });
  router.use('/authorize', authorizationHandler({ provider: consent.asProvider() }));

  const tokenLimiter = new RateLimiter(120, 15 * 60 * 1000, ctx.now);
  const tokenBody = [
    express.urlencoded({ extended: false, limit: '16kb' }),
    express.json({ limit: '16kb' }),
  ];

  router.options(['/token', '/revoke'], (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
  });

  router.post('/token', ...tokenBody, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      if (!tokenLimiter.take(req.ip ?? 'unknown')) throw new TooManyRequestsError('Slow down');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const client = await tokens.authenticateClient(body, req.headers.authorization);
      const checkResource = (r: string | undefined) => {
        if (r !== undefined && (!URL.canParse(r) || !resourceMatches(new URL(r), ctx.publicUrl))) {
          throw new InvalidTargetError('resource is not this MCP server');
        }
      };
      if (body.grant_type === 'authorization_code') {
        const p = CodeGrant.safeParse(body);
        if (!p.success) throw new InvalidRequestError('code and code_verifier are required');
        checkResource(p.data.resource);
        res.json(
          await tokens.exchangeCode(client, {
            code: p.data.code,
            codeVerifier: p.data.code_verifier,
            redirectUri: p.data.redirect_uri,
          }),
        );
        return;
      }
      if (body.grant_type === 'refresh_token') {
        const p = RefreshGrant.safeParse(body);
        if (!p.success) throw new InvalidRequestError('refresh_token is required');
        checkResource(p.data.resource);
        res.json(await tokens.refresh(client, p.data.refresh_token));
        return;
      }
      throw new UnsupportedGrantTypeError(
        'Only authorization_code and refresh_token are supported',
      );
    } catch (e) {
      if (!(e instanceof OAuthError)) {
        ctx.logger?.error({ route: 'token', ...errorFields(e) }, 'token error');
      }
      sendOAuthError(res, e);
    }
  });

  router.post('/revoke', ...tokenBody, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      if (!tokenLimiter.take(req.ip ?? 'unknown')) throw new TooManyRequestsError('Slow down');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const client = await tokens.authenticateClient(body, req.headers.authorization);
      if (typeof body.token !== 'string' || !body.token)
        throw new InvalidRequestError('token is required');
      await tokens.revoke(client, body.token);
      res.status(200).json({});
    } catch (e) {
      if (!(e instanceof OAuthError)) {
        ctx.logger?.error({ route: 'revoke', ...errorFields(e) }, 'revoke error');
      }
      sendOAuthError(res, e);
    }
  });

  return { router, tokens, clients };
}
