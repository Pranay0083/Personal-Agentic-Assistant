import { readFileSync } from 'node:fs';

/**
 * Recorded Gmail API responses (shape-exact, synthetic content). Used by tests and to
 * seed the fake mailboxes in GMAIL_FAKE mode. Never real account data.
 */
export function fixture<T = unknown>(name: string): T {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  return JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')) as T;
}
