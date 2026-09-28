import { randomBytes } from 'node:crypto';
import type { redis } from '@hub/server';

type Redis = ReturnType<typeof redis>;

/**
 * Per-account mutual exclusion for sync runs, plus a "dirty" flag so webhooks that
 * arrive while a sync is running are never lost: the waiting job marks the account
 * dirty and the lock holder runs again (or re-enqueues) before giving up the lock.
 */
export interface AccountLock {
  /** Takes the lock, or returns null if someone holds it. The release fn is idempotent. */
  tryAcquire(key: string, ttlMs?: number): Promise<(() => Promise<void>) | null>;
  markDirty(key: string): Promise<void>;
  /** Reads and clears the dirty flag. */
  takeDirty(key: string): Promise<boolean>;
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export class RedisAccountLock implements AccountLock {
  constructor(private readonly redis: Redis) {}

  async tryAcquire(key: string, ttlMs = 120_000) {
    const token = randomBytes(12).toString('hex');
    const k = `lock:${key}`;
    const ok = await this.redis.set(k, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    // Keep the lock alive while a long sync runs; it expires on its own if we crash.
    const timer = setInterval(
      () => {
        void this.redis.eval(EXTEND, 1, k, token, String(ttlMs)).catch(() => {});
      },
      Math.max(1000, Math.floor(ttlMs / 3)),
    );
    timer.unref();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await this.redis.eval(RELEASE, 1, k, token);
    };
  }

  async markDirty(key: string) {
    await this.redis.set(`dirty:${key}`, '1', 'EX', 3600);
  }

  async takeDirty(key: string) {
    return (await this.redis.getdel(`dirty:${key}`)) !== null;
  }
}

/** In-process lock for tests and single-process tools. */
export class MemoryAccountLock implements AccountLock {
  readonly held = new Set<string>();
  readonly dirty = new Set<string>();

  async tryAcquire(key: string) {
    if (this.held.has(key)) return null;
    this.held.add(key);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.held.delete(key);
    };
  }

  async markDirty(key: string) {
    this.dirty.add(key);
  }

  async takeDirty(key: string) {
    return this.dirty.delete(key);
  }
}
