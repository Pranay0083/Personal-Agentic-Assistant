import { EmailSendPayload } from '@hub/shared';
import { ConnectorError } from '../errors';
import { sha256Hex } from '../lib/index';
import type { ExecuteResult } from '../types';
import { outlookPrefer, type Graph } from './graph';
import type { GraphCollection, GraphMessage } from './graph-types';

/**
 * outlook.send. Every message carries a named single-value extended property (a MAPI
 * property in our own namespace) holding sha256(idempotencyKey). Graph can filter Sent
 * Items on it, which internetMessageHeaders can't do, so `findExecuted` can tell a crashed
 * send from one that never happened.
 */
export const IDEMPOTENCY_PROPERTY_ID =
  'String {8f0d5c3e-6a1b-4c7d-9e2f-3b4a5c6d7e8f} Name HubIdempotencyKey';

export const markerFor = (idempotencyKey: string) => sha256Hex(`outlook.send:${idempotencyKey}`);

/** Graph message ids (ImmutableId): base64url-ish, no angle brackets or `@`. */
const GRAPH_ID = /^[A-Za-z0-9+/=_-]{16,512}$/;

const recipients = (addrs: string[]) => addrs.map((address) => ({ emailAddress: { address } }));

export async function sendOutlook(
  graph: Graph,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<ExecuteResult> {
  const p = EmailSendPayload.parse(payload);
  const marker = markerFor(idempotencyKey);
  const props = [{ id: IDEMPOTENCY_PROPERTY_ID, value: marker }];
  if (p.inReplyTo) {
    if (!GRAPH_ID.test(p.inReplyTo)) {
      // An RFC 822 Message-ID (<x@y>) is Gmail's convention; Outlook replies need the
      // Graph message id from the item's `outlook:id:` label.
      throw new ConnectorError('microsoft', 'inReplyTo must be an Outlook message id');
    }
    await graph.request(`/me/messages/${encodeURIComponent(p.inReplyTo)}/reply`, {
      method: 'POST',
      prefer: outlookPrefer(),
      body: {
        message: {
          toRecipients: recipients(p.to),
          ccRecipients: recipients(p.cc),
          singleValueExtendedProperties: props,
        },
        comment: p.body,
      },
    });
  } else {
    await graph.request('/me/sendMail', {
      method: 'POST',
      body: {
        message: {
          subject: p.subject,
          body: { contentType: 'Text', content: p.body },
          toRecipients: recipients(p.to),
          ccRecipients: recipients(p.cc),
          singleValueExtendedProperties: props,
        },
        saveToSentItems: true,
      },
    });
  }
  // sendMail and reply answer 202 with no body: the sent copy's id is only known later.
  return {
    externalId: `outlook-marker:${marker}`,
    marker,
    ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
  };
}

/**
 * Looks for the marker in Sent Items. Needs Mail.Read: call it with the *read* token
 * context (Mail.Send cannot read the mailbox), exactly like Gmail's findExecuted. The sent
 * copy can take a few seconds to appear, so the executor should only trust a miss after
 * its usual retry delay.
 */
export async function findOutlookSent(
  graph: Graph,
  idempotencyKey: string,
): Promise<ExecuteResult | null> {
  const marker = markerFor(idempotencyKey);
  const filter = `singleValueExtendedProperties/any(ep: ep/id eq '${IDEMPOTENCY_PROPERTY_ID}' and ep/value eq '${marker}')`;
  const res = await graph.request<GraphCollection<GraphMessage>>(
    '/me/mailFolders/sentitems/messages',
    {
      query: { $filter: filter, $select: 'id,conversationId,internetMessageId', $top: 1 },
      prefer: outlookPrefer(),
    },
  );
  const hit = res.value?.[0];
  if (!hit?.id) return null;
  return {
    externalId: hit.id,
    threadId: hit.conversationId ?? null,
    internetMessageId: hit.internetMessageId ?? null,
    marker,
  };
}
