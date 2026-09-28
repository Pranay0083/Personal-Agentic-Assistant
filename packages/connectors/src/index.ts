import type { Provider } from '@hub/shared';
import { NotImplementedError } from './errors';
import { atlassian } from './atlassian/index';
import { github } from './github/index';
import { gmail } from './gmail/index';
import { microsoft } from './microsoft/index';
import { notion } from './notion/index';
import { slack } from './slack/index';
import type { Connector } from './types';

export * from './types';
export * from './errors';

const all: Record<Provider, Connector | null> = {
  gmail: gmail as Connector,
  microsoft,
  slack,
  atlassian,
  notion,
  github,
};

/** Implemented connectors. Providers missing here are not supported yet. */
export const connectors: Partial<Record<Provider, Connector>> = Object.fromEntries(
  Object.entries(all).filter(([, c]) => c !== null),
) as Partial<Record<Provider, Connector>>;

/** Returns the connector for a provider; throws NotImplementedError for unsupported ones. */
export function getConnector(provider: Provider | string): Connector {
  const c = connectors[provider as Provider];
  if (!c) throw new NotImplementedError(provider);
  return c;
}

export const isSupportedProvider = (p: string): p is Provider => !!connectors[p as Provider];
