import type { FastifyInstance } from 'fastify';
import type { Connector } from '@hub/connectors';
import { Provider } from '@hub/shared';
import type { ConnectorCatalogRes, ConnectorInfo } from '@hub/shared/api';
import type { Ctx } from '../context';
import { findConnector } from './accounts';

/** Catalog entries for providers without a connector yet (shown as "coming soon"). */
const PLACEHOLDERS: Record<
  Provider,
  Pick<ConnectorInfo, 'name' | 'covers' | 'multiAccountNote'>
> = {
  gmail: { name: 'Google', covers: 'Gmail, Calendar, Drive', multiAccountNote: null },
  microsoft: { name: 'Microsoft 365', covers: 'Outlook, Teams, OneDrive', multiAccountNote: null },
  slack: { name: 'Slack', covers: 'Channels, DMs, threads', multiAccountNote: 'One per workspace' },
  atlassian: { name: 'Atlassian', covers: 'Jira, Confluence', multiAccountNote: 'One per site' },
  notion: { name: 'Notion', covers: 'Pages and databases', multiAccountNote: 'One per workspace' },
  github: { name: 'GitHub', covers: 'Issues, pull requests, reviews', multiAccountNote: null },
};

function available(c: Connector): boolean {
  try {
    return c.configured();
  } catch {
    return false;
  }
}

/** Catalog data from a connector. Scopes and other server-side details are not exposed. */
export function catalogEntry(provider: Provider, c: Connector | undefined): ConnectorInfo {
  if (!c) {
    return {
      provider,
      ...PLACEHOLDERS[provider],
      available: false,
      sources: [],
      options: [],
      writeActions: [],
    };
  }
  const { info } = c;
  return {
    provider,
    name: info.name,
    covers: info.covers,
    multiAccountNote: info.multiAccountNote,
    available: available(c),
    sources: info.sources.map((s) => ({
      id: s.id,
      label: s.label,
      hint: s.hint,
      kind: s.kind,
      defaultOn: s.defaultOn,
    })),
    options: info.options.map((o) => ({
      key: o.key,
      label: o.label,
      hint: o.hint,
      type: o.type,
      choices: o.choices ?? [],
      default: o.default,
    })),
    writeActions: [...info.writeActions],
  };
}

export function connectorRoutes(app: FastifyInstance, ctx: Ctx) {
  // GET /connectors: every provider we know of, implemented or not, for the Connect screen.
  app.get('/connectors', async (): Promise<ConnectorCatalogRes> => ({
    connectors: Provider.options.map((p) => catalogEntry(p, findConnector(ctx, p))),
  }));
}
