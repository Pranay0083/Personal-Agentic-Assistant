import { hmacHex, header, safeEqual } from '../lib/crypto';
import type { VerifyResult, WebhookEvent, WebhookRequest } from '../types';

/**
 * GitHub App webhooks (one URL for every installation):
 * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, GITHUB_WEBHOOK_SECRET)>`,
 * `X-GitHub-Event` names the event, `X-GitHub-Delivery` is the unique delivery id.
 * Routed by `installation.id` (accounts.route_keys).
 */

const CONTENT_EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);
const INSTALLATION_EVENTS = new Set(['installation', 'installation_repositories']);

export function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${hmacHex('sha256', secret, rawBody)}`;
}

type Payload = {
  action?: string;
  installation?: { id?: number };
  sender?: { id?: number };
  repository?: { full_name?: string };
  issue?: { number?: number };
  pull_request?: { number?: number };
};

export function verifyGithubWebhook(req: WebhookRequest, secret: string | undefined): VerifyResult {
  if (!secret) return { ok: false, reason: 'GITHUB_WEBHOOK_SECRET is not set' };
  const sig = header(req.headers, 'x-hub-signature-256');
  if (!sig) return { ok: false, reason: 'missing X-Hub-Signature-256' };
  if (!safeEqual(sig, githubSignature(secret, req.rawBody)))
    return { ok: false, reason: 'bad signature' };

  const event = header(req.headers, 'x-github-event');
  const delivery = header(req.headers, 'x-github-delivery');
  if (!event || !delivery)
    return { ok: false, reason: 'missing X-GitHub-Event or X-GitHub-Delivery' };
  if (event === 'ping') return { ok: true, events: [] };
  const isInstall = INSTALLATION_EVENTS.has(event);
  if (!isInstall && !CONTENT_EVENTS.has(event)) return { ok: true, events: [] };

  const body = (req.body ?? {}) as Payload;
  const installationId = body.installation?.id;
  if (typeof installationId !== 'number') return { ok: true, events: [] };

  const payload: Record<string, unknown> = {
    event,
    ...(body.action ? { action: body.action } : {}),
    installationId,
    ...(body.repository?.full_name ? { repo: body.repository.full_name } : {}),
    ...((body.issue?.number ?? body.pull_request?.number)
      ? { number: body.issue?.number ?? body.pull_request?.number }
      : {}),
    // The account's route keys (installation ids) may be stale; the API should refresh them.
    ...(isInstall ? { refreshRouteKeys: true } : {}),
  };
  const events: WebhookEvent[] = [
    { providerEventId: delivery, routeKey: String(installationId), source: 'work', payload },
  ];
  // A new installation is not in anyone's route keys yet: also route to the installing user.
  if (isInstall && typeof body.sender?.id === 'number') {
    events.push({
      providerEventId: `${delivery}:sender`,
      externalAccountId: String(body.sender.id),
      source: 'work',
      payload,
    });
  }
  return { ok: true, events };
}
