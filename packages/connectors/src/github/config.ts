import { fakeMode } from '../lib/fake';

/**
 * Pinned REST API version (docs.github.com/en/rest/about-the-rest-api/api-versions, 2026-09).
 * 2026-03-10 drops the singular `assignee`; we read `assignees` only.
 */
export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Secret the fake webhook script signs with when GITHUB_WEBHOOK_SECRET is unset. */
export const FAKE_GITHUB_WEBHOOK_SECRET = 'fake-github-secret';
export const FAKE_GITHUB_APP_SLUG = 'hub-fake';

export type GithubConfig = {
  /** Serve the fake store instead of GitHub (CONNECTORS_FAKE=1). Never production. */
  fake: boolean;
  appId?: string;
  appSlug?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
};

export function githubConfigFromEnv(e: NodeJS.ProcessEnv = process.env): GithubConfig {
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    fake: fakeMode(),
    appId: opt(e.GITHUB_APP_ID),
    appSlug: opt(e.GITHUB_APP_SLUG),
    clientId: opt(e.GITHUB_CLIENT_ID),
    clientSecret: opt(e.GITHUB_CLIENT_SECRET),
    webhookSecret: opt(e.GITHUB_WEBHOOK_SECRET),
  };
}

export function githubWebhookSecret(c: GithubConfig): string | undefined {
  return c.webhookSecret ?? (c.fake ? FAKE_GITHUB_WEBHOOK_SECRET : undefined);
}

/** Where a user installs the app and picks repos. */
export function githubInstallUrl(c: GithubConfig): string {
  const slug = c.appSlug ?? (c.fake ? FAKE_GITHUB_APP_SLUG : 'hub');
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
