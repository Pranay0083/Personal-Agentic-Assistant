import type { PolicyAction, PolicyLevel, Preset, Resource } from '@hub/shared';

export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; userId: string; name: string }
  | { kind: 'mcp'; userId: string; clientId: string };

export type Decision = {
  allow: boolean;
  needsApproval: boolean;
  reason: string;
  /** Effective level after resolution, for UI and audit. */
  level: PolicyLevel;
  source: LevelSource;
};

export type LevelSource =
  'owner' | 'grant' | 'account' | 'provider' | 'global' | 'preset' | 'default';

export type PolicyRule = {
  principal: string;
  provider: string | null;
  accountId: string | null;
  resource: string;
  level: PolicyLevel;
};

export type GrantRule = {
  principal: string;
  accountId: string | null;
  provider: string | null;
  scope: string;
  level: PolicyLevel;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type PolicyContext = {
  user: { id: string; preset: Preset; paused: boolean };
  account: { id: string; userId: string; provider: string } | null;
  policies: PolicyRule[];
  grants: GrantRule[];
  now: Date;
};

export type { PolicyAction, PolicyLevel, Preset, Resource };
