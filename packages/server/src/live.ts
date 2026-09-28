import { Redis } from 'ioredis';
import type { LiveEvent } from '@hub/shared/queues';
import { env } from './env';
import { redis } from './queue';

const channel = (userId: string) => `live:${userId}`;

/** Workers publish; the API relays to the app over SSE. Events carry ids only. */
export async function publishLive(userId: string, event: LiveEvent) {
  await redis().publish(channel(userId), JSON.stringify(event));
}

/**
 * One Redis subscriber per SSE stream. Streams open and close often (app reconnects,
 * backgrounding), so every command here must tolerate the connection closing first:
 * an unhandled rejection would take down the whole API process.
 */
export function subscribeLive(userId: string, onEvent: (e: LiveEvent) => void) {
  const sub = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 1 });
  let closed = false;
  sub.on('error', () => {
    // Connection errors surface as a dropped stream; the app reconnects.
  });
  sub.subscribe(channel(userId)).catch(() => {
    // Closed before subscribing finished.
  });
  sub.on('message', (_ch, msg) => {
    if (closed) return;
    try {
      onEvent(JSON.parse(msg) as LiveEvent);
    } catch {
      // ignore malformed
    }
  });
  return () => {
    if (closed) return;
    closed = true;
    sub.quit().catch(() => sub.disconnect());
  };
}
