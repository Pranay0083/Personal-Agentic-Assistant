/**
 * Small in-memory fixed-window limiter. One process serves MCP, so this is enough for
 * the consent endpoints; move to Redis if the server is ever scaled horizontally.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}

  /** Returns true when the call is allowed, and counts it. */
  take(key: string): boolean {
    const t = this.now().getTime();
    if (this.hits.size > 10_000) this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.max;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
