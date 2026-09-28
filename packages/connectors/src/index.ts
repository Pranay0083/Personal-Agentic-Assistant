import type { Provider } from '@hub/shared';
import { NotImplementedError } from './errors';
import { gmail } from './gmail/index';
import type { Connector } from './types';

export * from './types';
export * from './errors';

/** Implemented connectors. Providers missing here are not supported yet. */
export const connectors: Partial<Record<Provider, Connector>> = {
  gmail: gmail as Connector,
};

/** Returns the connector for a provider; throws NotImplementedError for unsupported ones. */
export function getConnector(provider: Provider | string): Connector {
  const c = connectors[provider as Provider];
  if (!c) throw new NotImplementedError(provider);
  return c;
}

export const isSupportedProvider = (p: string): p is Provider => !!connectors[p as Provider];
