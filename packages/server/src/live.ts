import { Redis } from 'ioredis';
import type { LiveEvent } from '@hub/shared/queues';
import { env } from './env';
import { redis } from './queue';

const channel = (userId: string) => `live:${userId}`;

/** Workers publish; the API relays to the app over SSE. Events carry ids only. */
export async function publishLive(userId: string, event: LiveEvent) {
  await redis().publish(channel(userId), JSON.stringify(event));
}

export function subscribeLive(userId: string, onEvent: (e: LiveEvent) => void) {
  const sub = new Redis(env().REDIS_URL);
  void sub.subscribe(channel(userId));
  sub.on('message', (_ch, msg) => {
    try {
      onEvent(JSON.parse(msg) as LiveEvent);
    } catch {
      // ignore malformed
    }
  });
  return () => void sub.quit();
}
