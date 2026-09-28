import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GmailSendPayload } from '@hub/shared';
import { buildMime, encodeHeaderValue, messageIdFor, rfc822SearchId } from './mime';

const payload = (p: Partial<GmailSendPayload> = {}) =>
  GmailSendPayload.parse({
    to: ['priya@company.example'],
    subject: 'Re: Q3 roadmap slides',
    body: 'Here you go.\nAlex',
    ...p,
  });

const parse = (mime: string) => {
  const [head, body] = mime.split('\r\n\r\n');
  const headers = Object.fromEntries(
    head!.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
  );
  return { headers, body: Buffer.from(body!.replace(/\s+/g, ''), 'base64').toString('utf8') };
};

describe('MIME building', () => {
  it('uses a deterministic Message-ID derived from the idempotency key', () => {
    const sha = createHash('sha256').update('proposal:1').digest('hex');
    expect(messageIdFor('proposal:1')).toBe(`<${sha}@hub>`);
    expect(rfc822SearchId('proposal:1')).toBe(`${sha}@hub`);
    const a = buildMime({
      from: 'alex@company.example',
      payload: payload(),
      idempotencyKey: 'proposal:1',
    });
    const b = buildMime({
      from: 'alex@company.example',
      payload: payload(),
      idempotencyKey: 'proposal:1',
    });
    expect(parse(a).headers['Message-ID']).toBe(parse(b).headers['Message-ID']);
  });

  it('builds a plain reply with threading headers', () => {
    const mime = buildMime({
      from: 'alex@company.example',
      payload: payload({
        cc: ['jordan@company.example'],
        inReplyTo: '<CAF=q3roadmap.1@mail.company.example>',
        threadId: '192a7c3e5b1d0a01',
      }),
      idempotencyKey: 'k',
      date: new Date('2026-09-28T10:00:00Z'),
    });
    const { headers, body } = parse(mime);
    expect(headers).toMatchObject({
      From: 'alex@company.example',
      To: 'priya@company.example',
      Cc: 'jordan@company.example',
      Subject: 'Re: Q3 roadmap slides',
      'In-Reply-To': '<CAF=q3roadmap.1@mail.company.example>',
      References: '<CAF=q3roadmap.1@mail.company.example>',
      'MIME-Version': '1.0',
      'Content-Type': 'text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding': 'base64',
      Date: 'Mon, 28 Sep 2026 10:00:00 +0000',
    });
    expect(body).toBe('Here you go.\r\nAlex');
  });

  it('encodes non-ASCII subjects and rejects header injection', () => {
    expect(encodeHeaderValue('Grüße — hi')).toBe(
      `=?UTF-8?B?${Buffer.from('Grüße — hi').toString('base64')}?=`,
    );
    expect(() =>
      buildMime({
        from: 'a@b.example',
        payload: payload({ subject: 'x\r\nBcc: evil@x.example' }),
        idempotencyKey: 'k',
      }),
    ).toThrow();
    expect(() =>
      buildMime({
        from: 'a@b.example',
        payload: payload({ inReplyTo: '<a@b>\r\nBcc: e@x' }),
        idempotencyKey: 'k',
      }),
    ).toThrow();
    // Body content cannot inject headers: it is base64-encoded.
    const mime = buildMime({
      from: 'a@b.example',
      payload: payload({ body: '\r\n\r\nBcc: evil@x.example' }),
      idempotencyKey: 'k',
    });
    expect(mime).not.toContain('Bcc:');
  });
});
