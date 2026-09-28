import { providerHolds } from '@hub/policy';
import type { ItemKind } from '@hub/shared';
import { resourceFor, type AccountRow, type PolicyCache } from './common';

export type Withheld = { account: AccountRow; resources: string[] };

export type Readable = {
  /** accountId → item kinds the client may read there. */
  kinds: Map<string, ItemKind[]>;
  withheld: Withheld[];
  /** Every decision was a kill-switch denial. */
  paused: boolean;
};

/** Which (account, kind) pairs the principal may read, and which were withheld. */
export async function readableKinds(
  cache: PolicyCache,
  accts: AccountRow[],
  kinds: readonly ItemKind[],
): Promise<Readable> {
  const out: Readable = { kinds: new Map(), withheld: [], paused: false };
  let decisions = 0;
  let pausedDenials = 0;
  for (const a of accts) {
    const allowed: ItemKind[] = [];
    const denied = new Set<string>();
    for (const kind of kinds) {
      const resource = resourceFor(kind);
      if (!providerHolds(a.provider, resource)) continue;
      const d = await cache.check(a.id, resource, 'read');
      decisions++;
      if (d.allow) allowed.push(kind);
      else {
        denied.add(resource);
        if (d.reason === 'all agents are paused') pausedDenials++;
      }
    }
    if (allowed.length) out.kinds.set(a.id, allowed);
    if (denied.size) out.withheld.push({ account: a, resources: [...denied] });
  }
  out.paused = decisions > 0 && pausedDenials === decisions;
  return out;
}

/** Trusted (Hub-written) note naming withheld sources and how to ask for them. */
export function withheldNote(withheld: Withheld[]): string {
  if (!withheld.length) return '';
  const lines = withheld.map(
    (w) =>
      `- ${w.account.nickname} (${w.account.provider}, accountId ${w.account.id}): ${w.resources.join(', ')}`,
  );
  return [
    "Withheld by the user's permissions (not searched):",
    ...lines,
    'If you need one of these, call request_access with the accountId, the resource and a short reason; ' +
      'the user decides on their phone.',
  ].join('\n');
}

export function auditWithheld(withheld: Withheld[]) {
  return withheld.map((w) => ({ accountId: w.account.id, resources: w.resources }));
}
