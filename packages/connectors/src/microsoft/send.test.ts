import { describe, expect, it } from 'vitest';
import { ConnectorError, ReconnectRequiredError, RetryableError } from '../errors';
import { IDEMPOTENCY_PROPERTY_ID, markerFor } from './send';
import { fx, replay, testCtx } from './test-helpers';

const payload = {
  to: ['priya.raman@contoso.example'],
  cc: [],
  subject: 'Q4 budget',
  body: 'Approved, thanks!',
};
const writeCtx = () =>
  testCtx({
    tokens: {
      accessToken: 'write-token',
      refreshToken: 'rt-w',
      expiresAt: Date.parse('2026-09-28T11:00:00Z'),
    },
  });
const REPLY_TO = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AIiLKjG2I7E-Xvk-ys6MD0wAAMf9ItAAA';

describe('outlook.send', () => {
  it('sends a new message with the idempotency marker property and saves to Sent Items', async () => {
    const { connector, calls } = replay({ 'POST /v1.0/me/sendMail': { status: 202 } });
    const out = await connector.execute!(writeCtx(), 'outlook.send', payload, 'prop-1:v1');
    const body = JSON.parse(calls[0]!.body!) as {
      message: Record<string, unknown>;
      saveToSentItems: boolean;
    };
    expect(body.saveToSentItems).toBe(true);
    expect(body.message).toMatchObject({
      subject: 'Q4 budget',
      body: { contentType: 'Text', content: 'Approved, thanks!' },
      toRecipients: [{ emailAddress: { address: 'priya.raman@contoso.example' } }],
      singleValueExtendedProperties: [
        { id: IDEMPOTENCY_PROPERTY_ID, value: markerFor('prop-1:v1') },
      ],
    });
    expect(calls[0]!.headers.authorization).toBe('Bearer write-token');
    expect(out.marker).toBe(markerFor('prop-1:v1'));
    // The marker is a hash, never the key itself.
    expect(calls[0]!.body).not.toContain('prop-1:v1');
  });

  it('replies to the Outlook message id from inReplyTo', async () => {
    const { connector, calls } = replay({
      [`POST /v1.0/me/messages/${REPLY_TO}/reply`]: { status: 202 },
    });
    await connector.execute!(writeCtx(), 'outlook.send', { ...payload, inReplyTo: REPLY_TO }, 'k2');
    const body = JSON.parse(calls[0]!.body!) as {
      comment: string;
      message: Record<string, unknown>;
    };
    expect(body.comment).toBe('Approved, thanks!');
    expect(body.message.singleValueExtendedProperties).toEqual([
      { id: IDEMPOTENCY_PROPERTY_ID, value: markerFor('k2') },
    ]);
    expect(calls[0]!.headers.prefer).toContain('IdType="ImmutableId"');
  });

  it('refuses RFC 822 ids, invalid payloads and unknown actions', async () => {
    const { connector, calls } = replay({});
    await expect(
      connector.execute!(
        writeCtx(),
        'outlook.send',
        { ...payload, inReplyTo: '<abc@mail.example>' },
        'k',
      ),
    ).rejects.toBeInstanceOf(ConnectorError);
    await expect(
      connector.execute!(writeCtx(), 'outlook.send', { ...payload, to: ['not-an-email'] }, 'k'),
    ).rejects.toThrow();
    await expect(connector.execute!(writeCtx(), 'gmail.send', payload, 'k')).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(calls).toHaveLength(0);
  });

  it('maps 401 and 429 on send', async () => {
    const a = replay({ 'POST /v1.0/me/sendMail': { status: 401, body: fx('error-401.json') } });
    await expect(
      a.connector.execute!(writeCtx(), 'outlook.send', payload, 'k'),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    const b = replay({
      'POST /v1.0/me/sendMail': {
        status: 429,
        body: fx('error-429.json'),
        headers: { 'retry-after': '2' },
      },
    });
    const e = (await b.connector.execute!(writeCtx(), 'outlook.send', payload, 'k').catch(
      (x: unknown) => x,
    )) as RetryableError;
    expect(e).toBeInstanceOf(RetryableError);
    expect(e.retryAfterMs).toBe(2000);
  });

  it('findExecuted searches Sent Items for the marker', async () => {
    const hit = replay({
      'GET /v1.0/me/mailFolders/sentitems/messages': fx('sent-items-hit.json'),
    });
    const found = await hit.connector.findExecuted!(testCtx(), 'outlook.send', 'prop-1:v1');
    expect(found).toMatchObject({
      externalId: 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AIiLKjG2I7E-Xvk-ys6MD0wAAMf9ISENT2',
      threadId: 'AAQkAGI2TGuLAAAQAQAMfixtureConv1',
    });
    const filter = hit.calls[0]!.url.searchParams.get('$filter')!;
    expect(filter).toBe(
      `singleValueExtendedProperties/any(ep: ep/id eq '${IDEMPOTENCY_PROPERTY_ID}' and ep/value eq '${markerFor('prop-1:v1')}')`,
    );
    const miss = replay({
      'GET /v1.0/me/mailFolders/sentitems/messages': fx('sent-items-empty.json'),
    });
    expect(await miss.connector.findExecuted!(testCtx(), 'outlook.send', 'other')).toBeNull();
    expect(await miss.connector.findExecuted!(testCtx(), 'slack.post', 'other')).toBeNull();
  });
});
