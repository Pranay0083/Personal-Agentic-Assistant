import type { PolicyAction, PolicyLevel } from '@hub/shared';
import { principalSpecificity } from './principal';
import { ACTION_RESOURCES, DATA_RESOURCES, presetLevel, providerHolds } from './presets';
import type {
  Decision,
  GrantRule,
  LevelSource,
  PolicyContext,
  PolicyRule,
  Principal,
} from './types';

const RANK: Record<PolicyLevel, number> = {
  never: -1,
  none: 0,
  read: 1,
  draft: 2,
  ask: 3,
  auto: 4,
};

const deny = (
  reason: string,
  level: PolicyLevel = 'none',
  source: LevelSource = 'default',
): Decision => ({
  allow: false,
  needsApproval: false,
  reason,
  level,
  source,
});

function bestMatch<T extends { principal: string }>(rules: T[], p: Principal): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const r of rules) {
    const s = principalSpecificity(r.principal, p);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Resolution order (ARCHITECTURE.md): active grants → account-specific policies →
 * provider-wide policies → preset defaults → deny. A `never` from policy cannot be
 * lifted by a grant. Within one tier the most specific principal wins.
 */
export function resolveLevel(
  ctx: PolicyContext,
  p: Principal,
  resource: string,
): { level: PolicyLevel; source: LevelSource } {
  const account = ctx.account;
  if (!account || p.kind === 'user') return { level: 'auto', source: 'owner' };

  const forResource = ctx.policies.filter((r) => r.resource === resource);
  const tiers: [LevelSource, PolicyRule[]][] = [
    ['account', forResource.filter((r) => r.accountId === account.id)],
    [
      'provider',
      forResource.filter((r) => r.accountId === null && r.provider === account.provider),
    ],
    ['global', forResource.filter((r) => r.accountId === null && r.provider === null)],
  ];

  let base: { level: PolicyLevel; source: LevelSource } | undefined;
  for (const [source, rules] of tiers) {
    const hit = bestMatch(rules, p);
    if (hit) {
      base = { level: hit.level, source };
      break;
    }
  }
  if (!base) {
    const preset = presetLevel(ctx.user.preset, p.kind, resource);
    base = preset ? { level: preset, source: 'preset' } : { level: 'none', source: 'default' };
  }
  if (base.level === 'never') return base;

  const grant = bestMatch(activeGrants(ctx.grants, ctx, resource), p);
  if (grant && RANK[grant.level] > RANK[base.level] && grant.level !== 'never') {
    return { level: grant.level, source: 'grant' };
  }
  return base;
}

function activeGrants(grants: GrantRule[], ctx: PolicyContext, resource: string): GrantRule[] {
  const account = ctx.account!;
  return grants.filter(
    (g) =>
      !g.revokedAt &&
      g.expiresAt > ctx.now &&
      (g.scope === resource || g.scope === '*') &&
      (g.accountId === account.id ||
        (g.accountId === null && (g.provider === null || g.provider === account.provider))),
  );
}

export function decide(
  ctx: PolicyContext,
  p: Principal,
  resource: string,
  action: PolicyAction,
): Decision {
  if (p.userId !== ctx.user.id) return deny('principal belongs to another user');
  if (!ctx.account) return deny('account not found');
  if (ctx.account.userId !== p.userId) return deny('account belongs to another user');

  const isData = (DATA_RESOURCES as string[]).includes(resource);
  const isAction = (ACTION_RESOURCES as string[]).includes(resource);
  if (!isData && !isAction) return deny(`unknown resource ${resource}`);
  if (isData && action !== 'read') return deny(`${resource} is data; only read is valid`);
  if (isAction && action === 'read') return deny(`${resource} is an action; use draft or write`);
  if (!providerHolds(ctx.account.provider, resource)) {
    return deny(`${ctx.account.provider} has no ${resource}`);
  }

  if (p.kind === 'user') {
    return { allow: true, needsApproval: false, reason: 'owner', level: 'auto', source: 'owner' };
  }
  if (ctx.user.paused) return deny('all agents are paused');

  const { level, source } = resolveLevel(ctx, p, resource);
  const rank = RANK[level];
  const ok = (needsApproval: boolean, reason: string): Decision => ({
    allow: true,
    needsApproval,
    reason,
    level,
    source,
  });

  if (level === 'never') return deny(`${resource} is set to never`, level, source);

  switch (action) {
    case 'read':
      return rank >= RANK.read
        ? ok(false, `read allowed (${source})`)
        : deny(`no read access to ${resource}`, level, source);
    case 'draft':
      return rank >= RANK.draft
        ? ok(false, `draft allowed (${source})`)
        : deny(`cannot draft ${resource}`, level, source);
    case 'write':
      if (level === 'auto') return ok(false, `automatic (${source})`);
      if (level === 'ask') return ok(true, `needs your approval (${source})`);
      return deny(`cannot perform ${resource}`, level, source);
  }
}
