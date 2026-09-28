import { createHash } from 'node:crypto';
import type { GmailSendPayload } from '@hub/shared';

/** Deterministic Message-ID for an idempotency key, so a retried send is findable. */
export function messageIdFor(idempotencyKey: string): string {
  return `<${createHash('sha256').update(idempotencyKey).digest('hex')}@hub>`;
}

/** The bare id (no angle brackets) used with Gmail's `rfc822msgid:` search. */
export function rfc822SearchId(idempotencyKey: string): string {
  return messageIdFor(idempotencyKey).slice(1, -1);
}

const hasCtl = (s: string) => /[\r\n\0]/.test(s);

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeaderValue(v: string): string {
  if (hasCtl(v)) throw new Error('header value contains control characters');
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function assertAddress(a: string) {
  if (hasCtl(a) || /[<>,;"\s]/.test(a) || !/^[^@]+@[^@]+$/.test(a)) {
    throw new Error('invalid email address');
  }
  return a;
}

function assertMessageId(id: string) {
  const v = id.trim();
  if (hasCtl(v) || !/^<[^<>\s]+@[^<>\s]+>$/.test(v)) throw new Error('invalid Message-ID');
  return v;
}

function wrap76(b64: string) {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

export type BuildMimeOpts = {
  from: string;
  payload: GmailSendPayload;
  idempotencyKey: string;
  /** Extra References (the thread's chain), oldest first. */
  references?: string[];
  date?: Date;
};

/**
 * Builds an RFC 2822 message. Headers are validated against CR/LF injection; the body
 * is base64 so arbitrary content cannot inject headers or MIME boundaries.
 */
export function buildMime(opts: BuildMimeOpts): string {
  const { payload } = opts;
  const headers: string[] = [
    `From: ${assertAddress(opts.from)}`,
    `To: ${payload.to.map(assertAddress).join(', ')}`,
  ];
  if (payload.cc.length) headers.push(`Cc: ${payload.cc.map(assertAddress).join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(payload.subject)}`);
  headers.push(`Date: ${(opts.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`);
  headers.push(`Message-ID: ${messageIdFor(opts.idempotencyKey)}`);
  if (payload.inReplyTo) {
    const parent = assertMessageId(payload.inReplyTo);
    const refs = [...(opts.references ?? []).map(assertMessageId), parent];
    headers.push(`In-Reply-To: ${parent}`);
    headers.push(`References: ${[...new Set(refs)].join(' ')}`);
  }
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');
  const body = wrap76(
    Buffer.from(payload.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'),
  );
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export const toBase64Url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
