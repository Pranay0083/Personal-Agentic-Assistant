import type { Connector } from '../types';
import { createNotionConnector } from './connector';

export {
  createNotionConnector,
  parseNotionCursor,
  NOTION_INFO,
  type NotionConnectorOptions,
  type NotionCursor,
} from './connector';
export {
  NOTION_VERSION,
  FAKE_NOTION_VERIFICATION_TOKEN,
  notionConfigFromEnv,
  notionWebhookKey,
  type NotionConfig,
} from './config';
export { createNotionClient, type NotionClient, type NotionPage, type NotionBlock } from './client';
export {
  flattenPage,
  blockLine,
  richText,
  DEFAULT_FLATTEN_LIMITS,
  type FlattenLimits,
} from './blocks';
export { normalizeNotion, pageTitle, type NotionRecord } from './normalize';
export {
  verifyNotionWebhook,
  notionSignature,
  writeVerificationTokenFile,
  DEFAULT_VERIFICATION_TOKEN_FILE,
} from './webhook';
export {
  fakeNotionStore,
  fakeNotionFetch,
  seedFakeNotion,
  editFakePage,
  pickFakeWorkspace,
  type FakeNotionState,
} from './fake';

/**
 * The Notion connector (public integration, read-only). Configured from process.env on
 * each call: NOTION_CLIENT_ID/SECRET, NOTION_WEBHOOK_VERIFICATION_TOKEN, CONNECTORS_FAKE.
 */
export const notion: Connector = createNotionConnector() as Connector;
