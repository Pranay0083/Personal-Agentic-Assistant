import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hmacHex, header, safeEqual, sha256Hex } from '../lib/crypto';
import { defaultFakePath } from '../lib/fake';
import type { VerifyResult, WebhookEvent, WebhookRequest } from '../types';

/**
 * Notion integration webhooks (one subscription per integration, all workspaces).
 *
 * 1. Verification handshake: when the subscription is created Notion POSTs
 *    `{"verification_token":"secret_..."}` (unsigned). We answer 200 and hand the token
 *    to `onVerificationToken`, which by default writes it to
 *    `<repo>/.dev/notion-webhook-verification-token` (mode 0600) and logs only a hint and a
 *    short fingerprint, never the value. The operator pastes it into Notion's "Verify"
 *    dialog and into NOTION_WEBHOOK_VERIFICATION_TOKEN, then deletes the file.
 * 2. Events: `X-Notion-Signature: sha256=<hex HMAC-SHA256(raw body, verification token)>`,
 *    compared in constant time. Payloads carry ids only (entity, workspace, authors).
 */

export const NotionEvent = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  workspace_id: z.string().min(1),
  timestamp: z.string().optional(),
  subscription_id: z.string().optional(),
  attempt_number: z.number().optional(),
  entity: z.object({ id: z.string(), type: z.string() }).optional(),
});

/** Event families that can change page content or which pages exist. */
const SYNC_PREFIXES = ['page.', 'database.', 'data_source.'];

export type NotionWebhookLog = (msg: string, fields?: Record<string, unknown>) => void;

export const DEFAULT_VERIFICATION_TOKEN_FILE = () =>
  path.join(path.dirname(defaultFakePath('notion')), 'notion-webhook-verification-token');

/** Default handshake sink: a 0600 file next to the fake stores. Returns where it went. */
export function writeVerificationTokenFile(
  token: string,
  file = DEFAULT_VERIFICATION_TOKEN_FILE(),
) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function notionSignature(key: string, rawBody: string): string {
  return `sha256=${hmacHex('sha256', key, rawBody)}`;
}

export type NotionVerifyOptions = {
  /** Verification token (signing key); undefined when not configured yet. */
  key: string | undefined;
  onVerificationToken?: (token: string) => string | void;
  log?: NotionWebhookLog;
};

const defaultLog: NotionWebhookLog = (msg, fields) =>
  console.warn(`[notion] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`);

export function verifyNotionWebhook(req: WebhookRequest, opts: NotionVerifyOptions): VerifyResult {
  const log = opts.log ?? defaultLog;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Handshake: unsigned, no event type, only the token.
  if (typeof body.verification_token === 'string' && body.type === undefined) {
    const token = body.verification_token;
    const fingerprint = sha256Hex(token).slice(0, 8);
    if (opts.key && safeEqual(opts.key, token)) {
      log('webhook verification request for the configured token; nothing to do', {
        fingerprint,
      });
    } else {
      const where = (opts.onVerificationToken ?? writeVerificationTokenFile)(token);
      log(
        'webhook verification request received: paste the verification_token into the Notion ' +
          'integration "Verify" dialog and set NOTION_WEBHOOK_VERIFICATION_TOKEN to it, then restart the gateway',
        { fingerprint, ...(where ? { savedTo: where } : {}) },
      );
    }
    return { ok: true, events: [], reply: { status: 200, body: { ok: true } } };
  }

  if (!opts.key) return { ok: false, reason: 'NOTION_WEBHOOK_VERIFICATION_TOKEN is not set' };
  const sig = header(req.headers, 'x-notion-signature');
  if (!sig) return { ok: false, reason: 'missing X-Notion-Signature' };
  if (!safeEqual(sig, notionSignature(opts.key, req.rawBody))) {
    return { ok: false, reason: 'bad signature' };
  }

  const ev = NotionEvent.safeParse(body);
  if (!ev.success) return { ok: false, reason: 'bad event payload' };
  const e = ev.data;
  if (!SYNC_PREFIXES.some((p) => e.type.startsWith(p))) {
    // Comments and anything newer: acknowledged, nothing to sync.
    return { ok: true, events: [] };
  }
  const event: WebhookEvent = {
    providerEventId: e.id,
    routeKey: e.workspace_id,
    source: 'pages',
    payload: {
      type: e.type,
      ...(e.entity ? { entityId: e.entity.id, entityType: e.entity.type } : {}),
      ...(e.timestamp ? { timestamp: e.timestamp } : {}),
    },
  };
  return { ok: true, events: [event] };
}
