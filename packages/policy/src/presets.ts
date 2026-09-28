import type { ActionResource, DataResource, PolicyLevel, Preset } from '@hub/shared';
import type { PolicyRule } from './types';

export const DATA_RESOURCES: DataResource[] = [
  'email',
  'chat',
  'tickets',
  'notes',
  'calendar',
  'files',
  'code',
];
export const ACTION_RESOURCES: ActionResource[] = [
  'task.create',
  'draft.write',
  'message.send',
  'ticket.update',
  'email.label',
];

/** Which resources each provider actually holds. Anything else is denied outright. */
export const PROVIDER_RESOURCES: Record<string, string[]> = {
  // `gmail` is the Google account: Gmail, Calendar, Drive and (Workspace only) Chat.
  gmail: ['email', 'calendar', 'files', 'chat', 'message.send', 'email.label'],
  microsoft: ['email', 'chat', 'calendar', 'files', 'message.send', 'email.label'],
  slack: ['chat', 'files', 'message.send'],
  atlassian: ['tickets', 'notes', 'ticket.update'],
  notion: ['notes'],
  github: ['code', 'tickets', 'ticket.update'],
};
/** Hub-internal actions, valid on any account. */
const ANY_PROVIDER = ['task.create', 'draft.write'];

export function providerHolds(provider: string, resource: string): boolean {
  return (
    ANY_PROVIDER.includes(resource) || (PROVIDER_RESOURCES[provider]?.includes(resource) ?? false)
  );
}

type Table = Record<Preset, Record<string, PolicyLevel>>;

const allData = (level: PolicyLevel) =>
  Object.fromEntries(DATA_RESOURCES.map((r) => [r, level])) as Record<DataResource, PolicyLevel>;

/** Background agents (triage, extractor, brief, reply). They must read to do their job. */
const AGENT_DEFAULTS: Table = {
  cautious: {
    ...allData('read'),
    'task.create': 'ask',
    'draft.write': 'ask',
    'message.send': 'ask',
    'ticket.update': 'ask',
    'email.label': 'never',
  },
  balanced: {
    ...allData('read'),
    'task.create': 'auto',
    'draft.write': 'auto',
    'message.send': 'ask',
    'ticket.update': 'ask',
    'email.label': 'ask',
  },
  hands: {
    ...allData('read'),
    'task.create': 'auto',
    'draft.write': 'auto',
    // Sending still asks, even hands-off.
    'message.send': 'ask',
    'ticket.update': 'ask',
    'email.label': 'auto',
  },
};

/** External MCP clients (Claude, Claude Code, Cursor). */
const MCP_DEFAULTS: Table = {
  cautious: {
    ...allData('none'),
    tickets: 'read',
    code: 'read',
    notes: 'read',
    files: 'read',
    'task.create': 'ask',
    'draft.write': 'ask',
    'message.send': 'never',
    'ticket.update': 'never',
    'email.label': 'never',
  },
  balanced: {
    ...allData('read'),
    'task.create': 'auto',
    'draft.write': 'auto',
    'message.send': 'ask',
    'ticket.update': 'ask',
    'email.label': 'ask',
  },
  hands: {
    ...allData('read'),
    'task.create': 'auto',
    'draft.write': 'auto',
    'message.send': 'ask',
    'ticket.update': 'ask',
    'email.label': 'ask',
  },
};

export function presetLevel(
  preset: Preset,
  kind: 'agent' | 'mcp',
  resource: string,
): PolicyLevel | undefined {
  return (kind === 'agent' ? AGENT_DEFAULTS : MCP_DEFAULTS)[preset][resource];
}

/**
 * "Stricter for personal accounts": personal accounts stay read-only for agents and
 * hidden from MCP clients. Stored as account-specific policies (ARCHITECTURE.md).
 * MCP data is `none`, not `never`, so a temporary grant can still open it.
 */
export function strictPersonalPolicies(accountId: string): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const r of DATA_RESOURCES) {
    rules.push({ principal: 'mcp:*', provider: null, accountId, resource: r, level: 'none' });
  }
  for (const r of ['draft.write', 'message.send', 'ticket.update', 'email.label'] as const) {
    rules.push({ principal: 'agent:*', provider: null, accountId, resource: r, level: 'never' });
    rules.push({ principal: 'mcp:*', provider: null, accountId, resource: r, level: 'never' });
  }
  return rules;
}
