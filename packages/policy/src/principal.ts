import type { Principal } from './types';

export function principalKey(p: Principal): string {
  switch (p.kind) {
    case 'user':
      return 'user';
    case 'agent':
      return `agent:${p.name}`;
    case 'mcp':
      return `mcp:${p.clientId}`;
  }
}

export function parsePrincipal(key: string, userId: string): Principal {
  if (key === 'user') return { kind: 'user', userId };
  if (key.startsWith('agent:')) return { kind: 'agent', userId, name: key.slice(6) };
  if (key.startsWith('mcp:')) return { kind: 'mcp', userId, clientId: key.slice(4) };
  throw new Error(`unknown principal ${key}`);
}

/**
 * How specifically a stored principal key matches `p`.
 * 3 = exact, 2 = kind wildcard (`agent:*`), 1 = `*`, 0 = no match.
 */
export function principalSpecificity(ruleKey: string, p: Principal): number {
  const key = principalKey(p);
  if (ruleKey === key) return 3;
  if (p.kind !== 'user' && ruleKey === `${p.kind}:*`) return 2;
  if (ruleKey === '*' && p.kind !== 'user') return 1;
  return 0;
}
