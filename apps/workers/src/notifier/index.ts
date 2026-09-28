import { UnrecoverableError } from 'bullmq';
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { getDb } from '@hub/db';
import { createLogger, enqueue, env, redis, worker } from '@hub/server';
import { NotifierJob, QUEUES } from '@hub/shared/queues';
import type { Closable } from '../types';
import { processNotification, type Dedupe, type NotifierDeps, type PushSender } from './notify';

export * from './notify';
export * from './quiet';

/** Expo push sender. Invalid (non-Expo) tokens are skipped; chunks respect Expo limits. */
export function expoSender(accessToken?: string): PushSender {
  const expo = new Expo(accessToken ? { accessToken } : {});
  return {
    async send(messages: ExpoPushMessage[]) {
      const tickets: ExpoPushTicket[] = [];
      for (const m of messages) {
        if (!Expo.isExpoPushToken(m.to)) {
          tickets.push({
            status: 'error',
            message: 'invalid token',
            details: { error: 'DeviceNotRegistered', expoPushToken: String(m.to) },
          });
        }
      }
      const valid = messages.filter((m) => Expo.isExpoPushToken(m.to));
      for (const chunk of expo.chunkPushNotifications(valid)) {
        tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
      }
      return tickets;
    },
  };
}

export function redisDedupe(): Dedupe {
  return {
    async claim(key, ttl) {
      return (await redis().set(key, '1', 'EX', ttl, 'NX')) === 'OK';
    },
    async release(key) {
      await redis().del(key);
    },
  };
}

/** Starts the notifier worker. PUSH_FAKE=1 logs titles instead of sending. */
export function start(): Closable[] {
  const e = env();
  // env() already refuses PUSH_FAKE in production; fail closed here too.
  if (e.PUSH_FAKE && e.NODE_ENV === 'production') {
    throw new Error('PUSH_FAKE is not allowed in production');
  }
  const log = createLogger('notifier');
  const deps: NotifierDeps = {
    db: getDb(),
    push: e.PUSH_FAKE ? null : expoSender(e.EXPO_ACCESS_TOKEN),
    dedupe: redisDedupe(),
    enqueue: (queue, data, opts) => enqueue(queue, data, opts),
    now: () => new Date(),
    log,
  };
  const w = worker<unknown>(QUEUES.notifier, async (job) => {
    const parsed = NotifierJob.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid notifier job');
    return processNotification(deps, parsed.data);
  });
  return [w];
}
