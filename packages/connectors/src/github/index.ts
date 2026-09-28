import type { Connector } from '../types';
import { createGithubConnector } from './connector';

export {
  createGithubConnector,
  parseGithubCursor,
  workQueries,
  GITHUB_INFO,
  type GithubConnectorOptions,
  type GithubCursor,
} from './connector';
export {
  GITHUB_API_VERSION,
  FAKE_GITHUB_WEBHOOK_SECRET,
  githubConfigFromEnv,
  githubInstallUrl,
  githubWebhookSecret,
  type GithubConfig,
} from './config';
export {
  createGithubClient,
  rateLimitAware,
  repoOf,
  type GithubClient,
  type GithubIssue,
} from './client';
export { normalizeGithub, buildBody, githubItemId, type GithubRecord } from './normalize';
export { verifyGithubWebhook, githubSignature } from './webhook';
export {
  fakeGithubStore,
  fakeGithubFetch,
  fakeGithubAction,
  seedFakeGithub,
  pickFakeUser,
  type FakeGithubState,
} from './fake';

/**
 * The GitHub connector (GitHub App, user-to-server tokens, read-only). Configured from
 * process.env on each call: GITHUB_CLIENT_ID/SECRET, GITHUB_APP_SLUG, GITHUB_WEBHOOK_SECRET,
 * CONNECTORS_FAKE.
 */
export const github: Connector = createGithubConnector() as Connector;
