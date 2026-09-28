import type { Connector } from '../types';
import { createAtlassianConnector } from './connector';

export {
  createAtlassianConnector,
  checkScopes,
  mergeResources,
  ATLASSIAN_INFO,
  type AtlassianConnectorOptions,
  type AtlassianRecord,
} from './connector';
export {
  ATLASSIAN_SCOPES,
  READ_SCOPES,
  WRITE_SCOPES,
  atlassianConfigFromEnv,
  type AtlassianConfig,
} from './config';
export { adfToText, storageToText, textToAdf } from './text';
export { normalizeJira, type JiraRecord } from './jira';
export { normalizeConfluence, type ConfluenceRecord } from './confluence';
export { signJwt, verifyJwt, webhookUrl, WEBHOOK_EVENTS } from './webhooks';
export { execPropertyKey } from './execute';
export {
  FakeAtlassianStore,
  defaultFakeStore,
  memoryFakeStore,
  seedFakeAtlassian,
  DEFAULT_FAKE_STORE_PATH,
} from './fake-store';
export { fakeAtlassianFetch, FAKE_STATUSES } from './fake';

/** The default Atlassian connector: configured from process.env on each call. */
export const atlassian: Connector = createAtlassianConnector() as Connector;
