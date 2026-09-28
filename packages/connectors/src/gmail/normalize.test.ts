import { describe, expect, it } from 'vitest';
import { AccountFilters } from '@hub/shared';
import type { GmailMessage } from './client';
import { backfillQuery, gmailAccepts, watchLabelIds } from './filters';
import { fixture } from './fixtures/index';
import { htmlToText, normalizeGmail, parseAddress } from './normalize';

const msg = (name: string) => fixture<GmailMessage>(name);
const rec = (name: string, accountEmail = 'alex@company.example') => ({
  message: msg(name),
  accountEmail,
});

describe('normalizeGmail', () => {
  it('maps a multipart/alternative message, preferring text/plain', () => {
    const item = normalizeGmail(rec('message-multipart.json'))!;
    expect(item).toMatchObject({
      kind: 'email',
      externalId: '192a7c3e5b1d0a01',
      threadId: '192a7c3e5b1d0a01',
      author: 'Priya Raman',
      authorAddress: 'priya@company.example',
      title: 'Q3 roadmap slides by Thursday?',
      fromMe: false,
      url: 'https://mail.google.com/mail/u/alex%40company.example/#all/192a7c3e5b1d0a01',
    });
    expect(item.body).toContain('Q3 roadmap slides by Thursday 5pm');
    expect(item.body).toContain('Thanks — Priya');
    expect(item.body).not.toContain('<b>');
    expect(item.receivedAt.toISOString()).toBe(new Date(1790586761000).toISOString());
    expect(item.labels).toContain('INBOX');
    expect(item.labels).toContain('rfc822msgid:<CAF=q3roadmap.1@mail.company.example>');
    expect(item.labels).not.toContain('hub:from_me');
  });

  it('omits a malformed Message-ID instead of storing it', () => {
    const m = msg('message-personal.json');
    const headers = m.payload!.headers!.map((h) =>
      h.name === 'Message-ID' ? { ...h, value: '<a b@c>\r\nX: y' } : h,
    );
    const item = normalizeGmail({ ...m, payload: { ...m.payload, headers } })!;
    expect(item.labels.some((l) => l.startsWith('rfc822msgid:'))).toBe(false);
  });

  it('falls back to stripped text/html and drops script/style', () => {
    const item = normalizeGmail(rec('message-html-only.json'))!;
    expect(item.author).toBe('Jordan Blake (Jira)');
    expect(item.body).toContain('[HUB-142] Webhook retries double-send');
    expect(item.body).toContain('twice & the customer noticed');
    expect(item.body).toContain('<before>');
    expect(item.body).not.toMatch(/track\(\)|font-family|<p>/);
    expect(item.summary).toContain('twice & the customer');
  });

  it('sets fromMe for SENT mail and decodes snippet entities', () => {
    const item = normalizeGmail(rec('message-sent.json'))!;
    expect(item.fromMe).toBe(true);
    expect(item.labels).toContain('hub:from_me');
    expect(item.authorAddress).toBe('alex@company.example');
    expect(item.summary).toBe(
      "Hi Morgan, I'll get you the signed MSA by end of day Wednesday. Alex",
    );
    expect(item.threadId).toBe('192a7c3e5b1d0a00');
  });

  it('finds the text part inside multipart/mixed and ignores attachments', () => {
    const item = normalizeGmail(rec('message-attachment.json'))!;
    expect(item.body).toBe(
      'Hi Alex,\n\nInvoice INV-2291 for September is attached. Payment is due within 30 days.\n\nBest,\nAccounts team',
    );
  });

  it('decodes a single-part body and accepts a bare message', () => {
    const item = normalizeGmail(msg('message-personal.json'))!;
    expect(item.body).toContain('dinner Saturday at 7');
    expect(item.url).toBe('https://mail.google.com/mail/u/0/#all/192a8e0f11c2b301');
  });

  it('skips drafts', () => {
    expect(normalizeGmail({ ...msg('message-personal.json'), labelIds: ['DRAFT'] })).toBeNull();
  });
});

describe('helpers', () => {
  it('parses addresses', () => {
    expect(parseAddress('"Doe, Jane" <Jane@X.example>, bob@y.example')).toEqual({
      name: 'Doe, Jane',
      address: 'jane@x.example',
    });
    expect(parseAddress('bob@y.example')).toEqual({ name: null, address: 'bob@y.example' });
    expect(parseAddress(null)).toEqual({ name: null, address: null });
  });

  it('strips html', () => {
    expect(htmlToText('<p>a&nbsp;&amp;&#x41;</p><br>b')).toBe('a &A\n\nb');
    expect(htmlToText('<td>x</td><td>y</td>')).toBe('x y');
  });
});

describe('filters', () => {
  const defaults = AccountFilters.parse({});
  const labelsOf = (name: string) => msg(name).labelIds ?? [];

  it('default filters: inbox + sent, promotions and social off', () => {
    expect(gmailAccepts(labelsOf('message-multipart.json'), defaults)).toBe(true);
    expect(gmailAccepts(labelsOf('message-sent.json'), defaults)).toBe(true);
    expect(gmailAccepts(labelsOf('message-promotions.json'), defaults)).toBe(false);
    expect(gmailAccepts(labelsOf('message-social.json'), defaults)).toBe(false);
    expect(gmailAccepts(['SPAM', 'INBOX'], defaults)).toBe(false);
  });

  it('honours the sent toggle, promotions toggle and extra labels', () => {
    expect(gmailAccepts(['SENT'], { ...defaults, sent: false })).toBe(false);
    expect(gmailAccepts(['INBOX', 'CATEGORY_PROMOTIONS'], { ...defaults, promotions: true })).toBe(
      true,
    );
    expect(gmailAccepts(['Label_1'], defaults)).toBe(false);
    expect(gmailAccepts(['Label_1'], { ...defaults, inbox: false, labels: ['Label_1'] })).toBe(
      true,
    );
  });

  it('builds watch labels and backfill queries', () => {
    expect(watchLabelIds(defaults)).toEqual(['INBOX', 'SENT']);
    expect(watchLabelIds({ ...defaults, sent: false, labels: ['Label_9'] })).toEqual([
      'INBOX',
      'Label_9',
    ]);
    expect(backfillQuery(30, defaults)).toBe(
      'newer_than:30d -in:spam -in:trash -in:drafts -category:promotions -category:social',
    );
    expect(backfillQuery(7, { ...defaults, sent: false, promotions: true })).toBe(
      'newer_than:7d -in:spam -in:trash -in:drafts in:inbox',
    );
  });
});
