/** Shared helpers for this app's tests. Not used at runtime. */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpClients, mcpOauthClients, type Db } from '@hub/db';
import { hashToken, randomToken } from '@hub/server';
import { LocalKeyProvider } from '@hub/server/secrets';
import type { LiveEvent } from '@hub/shared/queues';
import { buildMcpApp } from './app';
import type { McpDeps } from './deps';

export type Harness = {
  base: string;
  mcpUrl: string;
  keys: LocalKeyProvider;
  jobs: { name: string; data: unknown; opts?: { jobId?: string } }[];
  live: { userId: string; event: LiveEvent }[];
  close: () => Promise<void>;
};

export async function startHarness(db: Db, over: Partial<McpDeps> = {}): Promise<Harness> {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const keys = new LocalKeyProvider(randomBytes(32).toString('base64'));
  const jobs: Harness['jobs'] = [];
  const live: Harness['live'] = [];
  const app = buildMcpApp({
    db,
    secrets: keys,
    enqueue: async (name, data, opts) => {
      jobs.push({ name, data, opts });
    },
    publishLive: async (userId, event) => {
      live.push({ userId, event });
    },
    publicUrl: `${base}/mcp`,
    ...over,
  });
  server.on('request', app);
  return {
    base,
    mcpUrl: `${base}/mcp`,
    keys,
    jobs,
    live,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Creates a connected MCP client row directly, skipping the OAuth dance. */
export async function issueClient(db: Db, userId: string, name = 'Claude Code') {
  const oauthClientId = `test-${randomToken(8)}`;
  await db.insert(mcpOauthClients).values({
    clientId: oauthClientId,
    name,
    redirectUris: ['http://127.0.0.1:1/cb'],
  });
  const token = `hub_at_${randomToken(32)}`;
  const [row] = await db
    .insert(mcpClients)
    .values({
      userId,
      oauthClientId,
      name,
      tokenHash: hashToken(token),
      refreshTokenHash: hashToken(`hub_rt_${randomToken(32)}`),
      scopes: ['hub'],
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning({ id: mcpClients.id });
  return { token, clientId: row!.id, key: `mcp:${row!.id}` };
}

export async function connectClient(mcpUrl: string, token: string) {
  const client = new Client({ name: 'hub-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** Text of a tool result. */
export function resultText(r: unknown): string {
  const content = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}
