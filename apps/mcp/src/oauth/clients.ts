import { eq } from 'drizzle-orm';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { mcpOauthClients, type Db } from '@hub/db';
import { hashToken } from '@hub/server';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);

/**
 * OAuth 2.1 redirect URIs: https anywhere, http only on loopback, or a private-use
 * scheme (cursor://, vscode://). Never a scheme that runs code in our origin.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (BLOCKED_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  // Private-use URI scheme per RFC 8252 §7.1.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/**
 * Key in mcp_oauth_clients.metadata where refresh-token state is kept per mcp_clients row
 * (see tokens.ts). Server-side only: never part of the client information.
 */
export const REFRESH_STATE_KEY = 'hubRefresh';

export type StoredClient = OAuthClientInformationFull & { secretHash: string | null };

/** Dynamic client registration store. Secrets are kept as SHA-256 hashes only. */
export class HubClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Db) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const c = await this.getStored(clientId);
    if (!c) return undefined;
    // The SDK authorize handler never needs the secret; the token endpoint uses the hash.
    const { secretHash: _secretHash, ...info } = c;
    return info;
  }

  async getStored(clientId: string): Promise<StoredClient | undefined> {
    if (clientId.length > 200) return undefined;
    const [row] = await this.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, clientId));
    if (!row) return undefined;
    const { [REFRESH_STATE_KEY]: _refreshState, ...meta } = (row.metadata ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...(meta as Partial<OAuthClientInformationFull>),
      client_id: row.clientId,
      client_name: row.name,
      redirect_uris: row.redirectUris as string[],
      secretHash: row.clientSecretHash,
    } as StoredClient;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    if (!client.client_id) throw new InvalidClientMetadataError('client_id was not generated');
    if (client.redirect_uris.length === 0 || client.redirect_uris.length > 10) {
      throw new InvalidClientMetadataError('between 1 and 10 redirect_uris are required');
    }
    for (const uri of client.redirect_uris) {
      if (!isAcceptableRedirectUri(uri)) {
        throw new InvalidClientMetadataError(
          'redirect_uris must be https, http on a loopback address, or a private-use scheme',
        );
      }
    }
    const grantTypes = client.grant_types ?? ['authorization_code', 'refresh_token'];
    if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      throw new InvalidClientMetadataError(
        'only authorization_code and refresh_token are supported',
      );
    }
    const name = (client.client_name ?? '').trim().slice(0, 80) || 'MCP client';
    const { client_secret, ...rest } = client;
    const metadata: Record<string, unknown> = {
      ...rest,
      client_name: name,
      grant_types: grantTypes,
    };
    // A client never gets to seed server-side state.
    delete metadata[REFRESH_STATE_KEY];
    await this.db.insert(mcpOauthClients).values({
      clientId: client.client_id,
      clientSecretHash: client_secret ? hashToken(client_secret) : null,
      name,
      redirectUris: client.redirect_uris,
      metadata,
    });
    // The plaintext secret is returned to the registering client once and never stored.
    return {
      ...metadata,
      client_id: client.client_id,
      client_secret,
    } as OAuthClientInformationFull;
  }
}
