import { describe, expect, it } from 'vitest';
import type { PolicyLevel, Preset } from '@hub/shared';
import { decide, resolveLevel } from './decide';
import { ACTION_RESOURCES, DATA_RESOURCES, strictPersonalPolicies } from './presets';
import type { GrantRule, PolicyContext, PolicyRule, Principal } from './types';

const U = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';
const WORK = '10000000-0000-0000-0000-000000000001';
const PERSONAL = '10000000-0000-0000-0000-000000000002';
const now = new Date('2026-09-28T10:00:00Z');

const triage: Principal = { kind: 'agent', userId: U, name: 'triage' };
const reply: Principal = { kind: 'agent', userId: U, name: 'reply' };
const code: Principal = { kind: 'mcp', userId: U, clientId: 'claude-code' };
const claude: Principal = { kind: 'mcp', userId: U, clientId: 'claude' };
const owner: Principal = { kind: 'user', userId: U };

function ctx(
  over: Partial<PolicyContext> & { preset?: Preset; paused?: boolean; accountId?: string } = {},
): PolicyContext {
  const accountId = over.accountId ?? WORK;
  return {
    user: { id: U, preset: over.preset ?? 'balanced', paused: over.paused ?? false },
    account:
      over.account === undefined ? { id: accountId, userId: U, provider: 'gmail' } : over.account,
    policies: over.policies ?? [],
    grants: over.grants ?? [],
    now,
  };
}

const rule = (
  principal: string,
  resource: string,
  level: PolicyLevel,
  scope: Partial<PolicyRule> = {},
): PolicyRule => ({
  principal,
  resource,
  level,
  provider: null,
  accountId: null,
  ...scope,
});

const grant = (
  principal: string,
  scope: string,
  level: PolicyLevel,
  over: Partial<GrantRule> = {},
): GrantRule => ({
  principal,
  scope,
  level,
  accountId: WORK,
  provider: null,
  expiresAt: new Date(now.getTime() + 3600_000),
  revokedAt: null,
  ...over,
});

describe('ownership and validity', () => {
  it('denies a principal of another user', () => {
    expect(
      decide(ctx(), { kind: 'agent', userId: OTHER, name: 'triage' }, 'email', 'read').allow,
    ).toBe(false);
  });
  it('denies an account owned by someone else', () => {
    const c = ctx({ account: { id: WORK, userId: OTHER, provider: 'gmail' } });
    expect(decide(c, triage, 'email', 'read')).toMatchObject({
      allow: false,
      reason: 'account belongs to another user',
    });
  });
  it('denies a missing account', () => {
    expect(decide(ctx({ account: null }), triage, 'email', 'read')).toMatchObject({
      allow: false,
      reason: 'account not found',
    });
  });
  it('denies resources the provider does not hold', () => {
    const jira = ctx({ account: { id: WORK, userId: U, provider: 'atlassian' } });
    expect(decide(jira, triage, 'email', 'read').allow).toBe(false);
    expect(decide(jira, triage, 'tickets', 'read').allow).toBe(true);
    expect(decide(jira, triage, 'message.send', 'draft').allow).toBe(false);
    expect(decide(jira, triage, 'task.create', 'write').allow).toBe(true);
  });
  it('denies unknown resources', () => {
    expect(decide(ctx(), triage, 'bank', 'read').allow).toBe(false);
  });
  it('rejects write on data resources and read on action resources', () => {
    expect(decide(ctx(), triage, 'email', 'write').allow).toBe(false);
    expect(decide(ctx(), triage, 'email', 'draft').allow).toBe(false);
    expect(decide(ctx(), triage, 'message.send', 'read').allow).toBe(false);
  });
});

describe('owner', () => {
  it('can do everything on their own accounts without approval', () => {
    const ms = ctx({ account: { id: WORK, userId: U, provider: 'microsoft' } });
    for (const r of ['email', 'chat', 'calendar', 'files'])
      expect(decide(ms, owner, r, 'read')).toMatchObject({ allow: true, needsApproval: false });
    for (const r of ['task.create', 'draft.write', 'message.send', 'email.label'])
      expect(decide(ms, owner, r, 'write')).toMatchObject({ allow: true, needsApproval: false });
  });
  it('is not affected by the kill switch', () => {
    expect(decide(ctx({ paused: true }), owner, 'message.send', 'write').allow).toBe(true);
  });
});

describe('kill switch', () => {
  it('denies every agent and MCP client, for every resource and action', () => {
    const c = ctx({ paused: true, preset: 'hands' });
    for (const p of [triage, reply, code, claude]) {
      for (const r of DATA_RESOURCES) expect(decide(c, p, r, 'read').allow).toBe(false);
      for (const r of ACTION_RESOURCES) expect(decide(c, p, r, 'write').allow).toBe(false);
      for (const r of ACTION_RESOURCES) {
        expect(decide(c, p, r, 'draft').allow).toBe(false);
        expect(decide(c, p, r, 'write').allow).toBe(false);
      }
    }
  });
  it('beats temporary grants', () => {
    const c = ctx({ paused: true, grants: [grant('mcp:claude-code', 'email', 'read')] });
    expect(decide(c, code, 'email', 'read').allow).toBe(false);
  });
});

describe('presets', () => {
  const table: [Preset, 'agent' | 'mcp', string, 'read' | 'draft' | 'write', boolean, boolean][] = [
    // preset, kind, resource, action, allow, needsApproval
    ['cautious', 'agent', 'email', 'read', true, false],
    ['cautious', 'agent', 'task.create', 'write', true, true],
    ['cautious', 'agent', 'message.send', 'draft', true, false],
    ['cautious', 'agent', 'message.send', 'write', true, true],
    ['cautious', 'agent', 'email.label', 'write', false, false],
    ['cautious', 'mcp', 'email', 'read', false, false],
    ['cautious', 'mcp', 'tickets', 'read', true, false],
    ['cautious', 'mcp', 'message.send', 'draft', false, false],
    ['balanced', 'agent', 'task.create', 'write', true, false],
    ['balanced', 'agent', 'draft.write', 'write', true, false],
    ['balanced', 'agent', 'message.send', 'write', true, true],
    ['balanced', 'agent', 'ticket.update', 'write', true, true],
    ['balanced', 'agent', 'email.label', 'write', true, true],
    ['balanced', 'mcp', 'email', 'read', true, false],
    ['balanced', 'mcp', 'message.send', 'draft', true, false],
    ['balanced', 'mcp', 'message.send', 'write', true, true],
    ['hands', 'agent', 'email.label', 'write', true, false],
    ['hands', 'agent', 'message.send', 'write', true, true],
    ['hands', 'mcp', 'message.send', 'write', true, true],
  ];
  it.each(table)(
    '%s %s %s %s → allow=%s approval=%s',
    (preset, kind, resource, action, allow, approval) => {
      const p = kind === 'agent' ? triage : code;
      const provider = resource.startsWith('ticket') ? 'atlassian' : 'gmail';
      const c = ctx({ preset, account: { id: WORK, userId: U, provider } });
      expect(decide(c, p, resource, action)).toMatchObject({
        allow,
        needsApproval: approval,
        source: 'preset',
      });
    },
  );
  it('sending never runs without approval under any preset', () => {
    for (const preset of ['cautious', 'balanced', 'hands'] as const) {
      for (const p of [triage, reply, code]) {
        const d = decide(ctx({ preset }), p, 'message.send', 'write');
        expect(d.allow === false || d.needsApproval === true).toBe(true);
      }
    }
  });
});

describe('resolution order', () => {
  it('provider-wide policy overrides the preset', () => {
    const c = ctx({ policies: [rule('mcp:claude-code', 'email', 'none', { provider: 'gmail' })] });
    expect(decide(c, code, 'email', 'read')).toMatchObject({ allow: false, source: 'provider' });
    expect(decide(c, claude, 'email', 'read')).toMatchObject({ allow: true, source: 'preset' });
  });
  it('provider-wide policy for another provider does not apply', () => {
    const c = ctx({
      policies: [rule('mcp:claude-code', 'email', 'none', { provider: 'microsoft' })],
    });
    expect(decide(c, code, 'email', 'read').allow).toBe(true);
  });
  it('account-specific policy overrides provider-wide', () => {
    const c = ctx({
      policies: [
        rule('mcp:claude-code', 'email', 'none', { provider: 'gmail' }),
        rule('mcp:claude-code', 'email', 'read', { accountId: WORK }),
      ],
    });
    expect(decide(c, code, 'email', 'read')).toMatchObject({ allow: true, source: 'account' });
    expect(
      decide(
        { ...c, account: { id: PERSONAL, userId: U, provider: 'gmail' } },
        code,
        'email',
        'read',
      ).allow,
    ).toBe(false);
  });
  it('global policy (no provider, no account) applies below provider-wide', () => {
    const c = ctx({ policies: [rule('agent:*', 'email.label', 'never')] });
    expect(decide(c, triage, 'email.label', 'write')).toMatchObject({
      allow: false,
      source: 'global',
    });
  });
  it('the most specific principal wins within a tier', () => {
    const c = ctx({
      policies: [
        rule('*', 'calendar', 'none', { provider: 'gmail' }),
        rule('mcp:*', 'calendar', 'read', { provider: 'gmail' }),
        rule('mcp:claude-code', 'calendar', 'none', { provider: 'gmail' }),
      ],
    });
    expect(decide(c, code, 'calendar', 'read').allow).toBe(false);
    expect(decide(c, claude, 'calendar', 'read').allow).toBe(true);
    expect(decide(c, triage, 'calendar', 'read').allow).toBe(false);
  });
  it('a wildcard rule never matches the owner', () => {
    const c = ctx({ policies: [rule('*', 'email', 'never')] });
    expect(decide(c, owner, 'email', 'read').allow).toBe(true);
  });
});

describe('temporary grants', () => {
  const hidden = [rule('mcp:claude-code', 'email', 'none', { provider: 'gmail' })];

  it('lift none to read for their account', () => {
    const c = ctx({ policies: hidden, grants: [grant('mcp:claude-code', 'email', 'read')] });
    expect(decide(c, code, 'email', 'read')).toMatchObject({ allow: true, source: 'grant' });
  });
  it('do not apply to other accounts, principals or resources', () => {
    const c = ctx({
      policies: hidden,
      grants: [grant('mcp:claude-code', 'email', 'read', { accountId: PERSONAL })],
    });
    expect(decide(c, code, 'email', 'read').allow).toBe(false);
    const c2 = ctx({ policies: hidden, grants: [grant('mcp:claude', 'email', 'read')] });
    expect(decide(c2, code, 'email', 'read').allow).toBe(false);
    const c3 = ctx({ policies: hidden, grants: [grant('mcp:claude-code', 'chat', 'read')] });
    expect(decide(c3, code, 'email', 'read').allow).toBe(false);
  });
  it('provider-wide grants cover every account of that provider', () => {
    const c = ctx({
      policies: hidden,
      grants: [grant('mcp:claude-code', 'email', 'read', { accountId: null, provider: 'gmail' })],
    });
    expect(decide(c, code, 'email', 'read').allow).toBe(true);
    const c2 = ctx({
      policies: hidden,
      grants: [grant('mcp:claude-code', 'email', 'read', { accountId: null, provider: 'slack' })],
    });
    expect(decide(c2, code, 'email', 'read').allow).toBe(false);
  });
  it('stop working once expired or revoked', () => {
    const expired = ctx({
      policies: hidden,
      grants: [
        grant('mcp:claude-code', 'email', 'read', { expiresAt: new Date(now.getTime() - 1) }),
      ],
    });
    expect(decide(expired, code, 'email', 'read').allow).toBe(false);
    const revoked = ctx({
      policies: hidden,
      grants: [grant('mcp:claude-code', 'email', 'read', { revokedAt: now })],
    });
    expect(decide(revoked, code, 'email', 'read').allow).toBe(false);
  });
  it('cannot lift never', () => {
    const c = ctx({
      policies: [rule('mcp:claude-code', 'message.send', 'never', { provider: 'gmail' })],
      grants: [grant('mcp:claude-code', 'message.send', 'auto')],
    });
    expect(decide(c, code, 'message.send', 'write')).toMatchObject({
      allow: false,
      level: 'never',
    });
  });
  it('never lower an existing level', () => {
    const c = ctx({ grants: [grant('agent:triage', 'task.create', 'read')] });
    expect(resolveLevel(c, triage, 'task.create')).toEqual({ level: 'auto', source: 'preset' });
  });
  it('wildcard scope covers every resource', () => {
    const c = ctx({ policies: hidden, grants: [grant('mcp:claude-code', '*', 'read')] });
    expect(decide(c, code, 'email', 'read').allow).toBe(true);
  });
});

describe('level semantics', () => {
  const cases: [PolicyLevel, 'read' | 'draft' | 'write', boolean, boolean][] = [
    ['none', 'draft', false, false],
    ['read', 'draft', false, false],
    ['draft', 'draft', true, false],
    ['draft', 'write', false, false],
    ['ask', 'draft', true, false],
    ['ask', 'write', true, true],
    ['auto', 'draft', true, false],
    ['auto', 'write', true, false],
    ['never', 'draft', false, false],
    ['never', 'write', false, false],
  ];
  it.each(cases)('%s + %s → allow=%s approval=%s', (level, action, allow, approval) => {
    const c = ctx({ policies: [rule('agent:reply', 'message.send', level, { accountId: WORK })] });
    expect(decide(c, reply, 'message.send', action)).toMatchObject({
      allow,
      needsApproval: approval,
    });
  });
  it.each(['none', 'never'] as const)('%s blocks reads', (level) => {
    const c = ctx({ policies: [rule('agent:triage', 'email', level, { accountId: WORK })] });
    expect(decide(c, triage, 'email', 'read').allow).toBe(false);
  });
  it.each(['read', 'draft', 'ask', 'auto'] as const)('%s allows reads', (level) => {
    const c = ctx({ policies: [rule('agent:triage', 'email', level, { accountId: WORK })] });
    expect(decide(c, triage, 'email', 'read').allow).toBe(true);
  });
});

describe('stricter for personal accounts', () => {
  const policies = strictPersonalPolicies(PERSONAL).map((r) => ({ ...r }));
  const personal = ctx({ accountId: PERSONAL, policies });
  const work = ctx({ accountId: WORK, policies });

  it('hides personal data from MCP clients', () => {
    for (const r of DATA_RESOURCES) expect(decide(personal, code, r, 'read').allow).toBe(false);
    expect(decide(personal, claude, 'calendar', 'read').allow).toBe(false);
    expect(decide(work, code, 'email', 'read').allow).toBe(true);
  });
  it('keeps personal accounts read-only for agents', () => {
    expect(decide(personal, triage, 'email', 'read').allow).toBe(true);
    for (const r of ['draft.write', 'message.send', 'email.label']) {
      expect(decide(personal, reply, r, 'draft').allow).toBe(false);
      expect(decide(personal, reply, r, 'write').allow).toBe(false);
    }
    expect(decide(work, reply, 'message.send', 'draft').allow).toBe(true);
  });
  it('still lets a temporary grant open personal email for reading', () => {
    const c = {
      ...personal,
      grants: [grant('mcp:claude-code', 'email', 'read', { accountId: PERSONAL })],
    };
    expect(decide(c, code, 'email', 'read').allow).toBe(true);
  });
  it('does not let a grant enable sending from a personal account', () => {
    const c = {
      ...personal,
      grants: [grant('mcp:claude-code', 'message.send', 'auto', { accountId: PERSONAL })],
    };
    expect(decide(c, code, 'message.send', 'write').allow).toBe(false);
  });
});
