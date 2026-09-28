import { randomInt } from 'node:crypto';
import { normalizePairingCode, pairingCodeHash } from '@hub/server';

export { normalizePairingCode, pairingCodeHash };

/**
 * Pairing codes for `mcp_connect`: the consent page shows a short code and the phone
 * must type it before Allow works. That ties the tap on the phone to the browser tab the
 * user is looking at, so a request started by someone else (with a borrowed client name)
 * can't be approved by reflex.
 *
 * Only `pairingCodeHash(requestId, code)` (from @hub/server, shared with the API) is stored.
 */
export const PAIRING_CODE_DIGITS = 6;

/** Six random digits (crypto RNG), leading zeros kept. */
export function newPairingCode(): string {
  return randomInt(0, 10 ** PAIRING_CODE_DIGITS)
    .toString()
    .padStart(PAIRING_CODE_DIGITS, '0');
}

/** "123 456" for display. */
export function formatPairingCode(code: string): string {
  const h = Math.ceil(code.length / 2);
  return `${code.slice(0, h)} ${code.slice(h)}`;
}
