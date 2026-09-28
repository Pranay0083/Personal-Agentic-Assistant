import { useEffect, useMemo, useState } from 'react';
import type { Provider } from '@hub/shared';
import { useAccounts, useConnectors } from './queries';
import type { AccountT, ConnectorInfoT } from './api';
import { serviceName } from './format';

/** Re-render every `ms` so relative times ("2m ago", countdowns) stay fresh. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Accounts indexed by id (for source tags and color dots). */
export function useAccountMap(): Map<string, AccountT> {
  const accounts = useAccounts();
  return useMemo(
    () => new Map((accounts.data?.accounts ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
}

export type ServiceGroup = {
  info: ConnectorInfoT;
  accounts: AccountT[];
  /** False when the catalog doesn't list this provider (or didn't load): name only. */
  known: boolean;
};

/**
 * Services from the hub's catalog (GET /connectors) in its order, each with the user's
 * accounts for it. Accounts of a provider the catalog doesn't list (the hub's config
 * changed) still show, under a "not set up" entry, so they can be reconnected or seen.
 */
export function useServices() {
  const catalog = useConnectors();
  const accounts = useAccounts();
  const groups = useMemo((): ServiceGroup[] => {
    const list = [...(accounts.data?.accounts ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const infos = (catalog.data?.connectors ?? []).map((info) => ({ info, known: true }));
    for (const a of list) {
      if (!infos.some((i) => i.info.provider === a.provider))
        infos.push({ info: fallbackInfo(a.provider), known: false });
    }
    return infos.map(({ info, known }) => ({
      info,
      known,
      accounts: list.filter((a) => a.provider === info.provider),
    }));
  }, [catalog.data, accounts.data]);
  return { catalog, accounts, groups };
}

export function fallbackInfo(provider: Provider): ConnectorInfoT {
  return {
    provider,
    name: serviceName(provider),
    covers: '',
    multiAccountNote: null,
    available: false,
    sources: [],
    options: [],
    writeActions: [],
  };
}

/** Catalog entries by provider (empty until GET /connectors loads). */
export function useCatalogMap(): Map<Provider, ConnectorInfoT> {
  const catalog = useConnectors();
  return useMemo(
    () => new Map((catalog.data?.connectors ?? []).map((c) => [c.provider, c])),
    [catalog.data],
  );
}

/** Number of connected accounts per provider (to decide when a tag needs the nickname). */
export function useProviderCounts(): Map<string, number> {
  const accounts = useAccounts();
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const a of accounts.data?.accounts ?? []) m.set(a.provider, (m.get(a.provider) ?? 0) + 1);
    return m;
  }, [accounts.data]);
}
