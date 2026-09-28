import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveCtx, type McpDeps } from './deps';
import { oauthRouter } from './oauth/router';
import type { McpAuthExtra } from './oauth/tokens';
import { createHubServer } from './tools';

export type { McpDeps } from './deps';

const MCP_CORS_HEADERS =
  'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID';

/**
 * The remote MCP server: OAuth 2.1 authorization server + Streamable HTTP at /mcp.
 * Stateless: every POST gets a fresh McpServer bound to the caller's principal.
 */
export function buildMcpApp(deps: McpDeps & { allowedHosts?: string[] }): Express {
  const ctx = resolveCtx(deps);
  const publicUrl = new URL(ctx.publicUrl);
  const app = express();
  app.disable('x-powered-by');
  // A local tunnel (cloudflared, ngrok) forwards from loopback.
  app.set('trust proxy', 'loopback');

  // DNS-rebinding protection: only our public host and loopback names.
  app.use(
    hostHeaderValidation([
      ...new Set([
        publicUrl.hostname,
        'localhost',
        '127.0.0.1',
        '[::1]',
        ...(deps.allowedHosts ?? []),
      ]),
    ]),
  );
  // Log method, path and status only: no query strings, headers or bodies.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () =>
      ctx.logger?.info(
        {
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        },
        'request',
      ),
    );
    next();
  });

  const oauth = oauthRouter(ctx);
  app.use(oauth.router);

  const mcpPath = publicUrl.pathname === '/' ? '/mcp' : publicUrl.pathname.replace(/\/+$/, '');
  const bearer = requireBearerAuth({
    verifier: oauth.tokens,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicUrl),
  });

  app.options(mcpPath, (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
    res.setHeader('Access-Control-Allow-Headers', MCP_CORS_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    res.status(204).end();
  });

  app.all(
    mcpPath,
    (_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
      next();
    },
    bearer,
    express.json({ limit: '1mb' }),
    async (req: Request, res: Response) => {
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
        res.setHeader('Allow', 'POST');
        res.status(405).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
        return;
      }
      const extra = req.auth?.extra as McpAuthExtra | undefined;
      if (!extra) {
        res.status(401).end();
        return;
      }
      const principal = { kind: 'mcp' as const, userId: extra.userId, clientId: extra.mcpClientId };
      const server = createHubServer({
        ctx,
        principal,
        key: `mcp:${extra.mcpClientId}`,
        clientName: extra.clientName,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        ctx.logger?.error({ err: (e as Error).message }, 'mcp request failed');
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    },
  );

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      if (!res.headersSent) res.status(status).json({ error: 'invalid_request' });
      return;
    }
    ctx.logger?.error({ err: (err as Error)?.message }, 'unhandled');
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });

  return app;
}
