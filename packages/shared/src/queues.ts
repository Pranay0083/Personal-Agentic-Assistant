import { z } from 'zod';

/**
 * Queue names and job payloads. One worker process per queue (apps/workers).
 * Payloads carry ids only, never message content or secrets.
 */
export const QUEUES = {
  sync: 'sync',
  backfill: 'backfill',
  agents: 'agents',
  executor: 'executor',
  notifier: 'notifier',
  scheduler: 'scheduler',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const SyncJob = z.object({
  accountId: z.uuid(),
  eventId: z.uuid().optional(),
  reason: z.enum(['webhook', 'catchup', 'manual']),
});
export type SyncJob = z.infer<typeof SyncJob>;

export const BackfillJob = z.object({
  accountId: z.uuid(),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  pageToken: z.string().optional(),
});
export type BackfillJob = z.infer<typeof BackfillJob>;

export const AgentJob = z.discriminatedUnion('agent', [
  z.object({ agent: z.literal('triage'), itemId: z.uuid() }),
  z.object({ agent: z.literal('extractor'), itemId: z.uuid() }),
  z.object({ agent: z.literal('reply'), itemId: z.uuid() }),
  z.object({ agent: z.literal('brief'), userId: z.uuid(), date: z.string() }),
]);
export type AgentJob = z.infer<typeof AgentJob>;

export const ExecutorJob = z.object({ proposalId: z.uuid() });
export type ExecutorJob = z.infer<typeof ExecutorJob>;

export const NotifierJob = z.object({
  userId: z.uuid(),
  kind: z.enum(['approval', 'vip', 'task', 'brief', 'access_request']),
  title: z.string(),
  body: z.string(),
  /** Deep-link data for the app, ids only. */
  data: z.record(z.string(), z.string()).default({}),
  /** Dedupe key so retries never double-notify. */
  dedupeKey: z.string(),
});
export type NotifierJob = z.infer<typeof NotifierJob>;

export const SchedulerJob = z.discriminatedUnion('task', [
  z.object({ task: z.literal('renew-subscriptions') }),
  z.object({ task: z.literal('catchup-sync') }),
  z.object({ task: z.literal('daily-briefs') }),
  z.object({ task: z.literal('expire-grants') }),
]);
export type SchedulerJob = z.infer<typeof SchedulerJob>;

/** Live events pushed to the app over SSE (and published on Redis by workers). */
export const LiveEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item.created'), itemId: z.uuid(), accountId: z.uuid() }),
  z.object({ type: z.literal('item.updated'), itemId: z.uuid() }),
  z.object({ type: z.literal('task.created'), taskId: z.uuid() }),
  z.object({ type: z.literal('task.updated'), taskId: z.uuid() }),
  z.object({ type: z.literal('proposal.created'), proposalId: z.uuid() }),
  z.object({ type: z.literal('proposal.updated'), proposalId: z.uuid() }),
  z.object({ type: z.literal('access_request.created'), requestId: z.uuid() }),
  z.object({ type: z.literal('account.updated'), accountId: z.uuid() }),
  z.object({ type: z.literal('brief.created'), briefId: z.uuid() }),
  z.object({ type: z.literal('control.changed'), paused: z.boolean() }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
