import { fakeMode } from '../lib/fake';

/**
 * Pinned Notion API version (checked against developers.notion.com/reference/versioning,
 * 2026-09). 2026-03-11 renamed `archived` to `in_trash`; we read both.
 */
export const NOTION_VERSION = '2026-03-11';
export const NOTION_API = 'https://api.notion.com';
export const NOTION_AUTHORIZE_URL = `${NOTION_API}/v1/oauth/authorize`;
export const NOTION_TOKEN_URL = `${NOTION_API}/v1/oauth/token`;
export const NOTION_REVOKE_URL = `${NOTION_API}/v1/oauth/revoke`;

/** Signing key the fake webhook script uses when NOTION_WEBHOOK_VERIFICATION_TOKEN is unset. */
export const FAKE_NOTION_VERIFICATION_TOKEN = 'fake-notion-token';

export type NotionConfig = {
  /** Serve the fake store instead of api.notion.com (CONNECTORS_FAKE=1). Never production. */
  fake: boolean;
  clientId?: string;
  clientSecret?: string;
  /** Key for X-Notion-Signature (the token Notion sends in the verification request). */
  webhookVerificationToken?: string;
};

export function notionConfigFromEnv(e: NodeJS.ProcessEnv = process.env): NotionConfig {
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    fake: fakeMode(),
    clientId: opt(e.NOTION_CLIENT_ID),
    clientSecret: opt(e.NOTION_CLIENT_SECRET),
    webhookVerificationToken: opt(e.NOTION_WEBHOOK_VERIFICATION_TOKEN),
  };
}

/** The key webhooks are verified with: the configured token, or the fake one in fake mode. */
export function notionWebhookKey(c: NotionConfig): string | undefined {
  return c.webhookVerificationToken ?? (c.fake ? FAKE_NOTION_VERIFICATION_TOKEN : undefined);
}
