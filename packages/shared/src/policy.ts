import { z } from 'zod';

/** Levels from ARCHITECTURE.md. `never` cannot be lifted by a grant; `none` can. */
export const PolicyLevel = z.enum(['none', 'read', 'draft', 'ask', 'auto', 'never']);
export type PolicyLevel = z.infer<typeof PolicyLevel>;

export const Preset = z.enum(['cautious', 'balanced', 'hands']);
export type Preset = z.infer<typeof Preset>;

/**
 * Resources. Data resources are read; action resources are drafted or written.
 * The same resource can be scoped to one account or to a whole provider.
 */
export const DataResource = z.enum([
  'email',
  'chat',
  'tickets',
  'notes',
  'calendar',
  'files',
  'code',
]);
export type DataResource = z.infer<typeof DataResource>;

export const ActionResource = z.enum([
  'task.create',
  'draft.write',
  'message.send',
  'ticket.update',
  'email.label',
]);
export type ActionResource = z.infer<typeof ActionResource>;

export const Resource = z.union([DataResource, ActionResource]);
export type Resource = z.infer<typeof Resource>;

export const PolicyAction = z.enum(['read', 'draft', 'write']);
export type PolicyAction = z.infer<typeof PolicyAction>;

/**
 * Principal strings as stored in `policies.principal` and `grants.principal`:
 * `user`, `agent:<name>`, `mcp:<clientId>`, or wildcards `agent:*`, `mcp:*`, `*`.
 */
export const PrincipalKey = z.string().regex(/^(user|\*|agent:[\w*-]+|mcp:[\w*-]+)$/);

export const AgentName = z.enum(['triage', 'extractor', 'brief', 'reply', 'planner']);
export type AgentName = z.infer<typeof AgentName>;

export const Policy = z.object({
  id: z.uuid(),
  principal: PrincipalKey,
  provider: z.string().nullable(),
  accountId: z.uuid().nullable(),
  resource: Resource,
  level: PolicyLevel,
});
export type Policy = z.infer<typeof Policy>;

export const Grant = z.object({
  id: z.uuid(),
  principal: PrincipalKey,
  accountId: z.uuid().nullable(),
  resource: Resource,
  level: PolicyLevel,
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type Grant = z.infer<typeof Grant>;

export const AccessRequestKind = z.enum(['access', 'mcp_connect']);

export const AccessRequest = z.object({
  id: z.uuid(),
  kind: AccessRequestKind,
  principal: z.string(),
  clientName: z.string().nullable(),
  /** False for dynamically registered clients: the name is self-chosen, show it as unverified. */
  clientNameVerified: z.boolean(),
  /** For `mcp_connect`: where the client will receive the code. The name is self-reported; this is not. */
  redirectHost: z.string().nullable(),
  accountId: z.uuid().nullable(),
  provider: z.string().nullable(),
  resource: z.string(),
  level: PolicyLevel,
  reason: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  status: z.enum(['pending', 'allowed', 'denied', 'expired']),
  createdAt: z.string(),
});
export type AccessRequest = z.infer<typeof AccessRequest>;
