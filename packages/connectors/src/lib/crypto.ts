import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** sha256 hex. `subscriptions.meta.secretHash` is stored in this form; the gateway compares it. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A random shared secret for a push subscription (Graph clientState, Google channel token). */
export function newSubscriptionSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(24).toString('base64url');
  return { secret, secretHash: sha256Hex(secret) };
}

export function hmacHex(algo: 'sha256' | 'sha1', key: string, data: string): string {
  return createHmac(algo, key).update(data).digest('hex');
}

/** Constant-time string compare; false on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
}
