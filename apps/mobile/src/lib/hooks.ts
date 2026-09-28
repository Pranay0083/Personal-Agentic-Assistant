import { useEffect, useMemo, useState } from 'react';
import { useAccounts } from './queries';
import type { AccountT } from './api';

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
