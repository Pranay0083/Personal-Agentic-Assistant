import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque random token (sessions, MCP tokens, auth codes). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored as SHA-256 hashes, never in the clear. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Digits only, so "123 456" and "123-456" match. */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/**
 * Hash of an MCP `mcp_connect` pairing code, salted with the access request id. The MCP
 * server stores it when the consent page shows the code; the API checks it on Allow.
 */
export function pairingCodeHash(requestId: string, code: string): string {
  return hashToken(`${requestId}:${normalizePairingCode(code)}`);
}
