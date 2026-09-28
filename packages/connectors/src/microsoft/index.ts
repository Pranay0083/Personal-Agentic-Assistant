import type { Connector } from '../types';
import { createMicrosoftConnector } from './connector';

export {
  createMicrosoftConnector,
  MICROSOFT_INFO,
  type MicrosoftConnectorOptions,
} from './connector';
export {
  MSA_TENANT_ID,
  MS_READ_SCOPES,
  MS_WRITE_SCOPES,
  MS_CHANNEL_SCOPES,
  msConfigFromEnv,
  type MicrosoftConfig,
} from './config';
export { normalizeMicrosoft, microsoftAccepts, htmlToText } from './normalize';
export { verifyGraphWebhook, sourceOfResource } from './webhook';
export { IDEMPOTENCY_PROPERTY_ID, markerFor } from './send';
export type { MsRecord } from './graph-types';
export {
  FakeMicrosoftStore,
  defaultFakeMsStore,
  memoryFakeMsStore,
  seedFakeMsState,
  DEFAULT_FAKE_MS_PATH,
} from './fake-store';
export { fakeGraphFetch, fakeMsAuthUrl } from './fake';

/** The default Microsoft 365 connector, configured from process.env on each call. */
export const microsoft: Connector = createMicrosoftConnector() as Connector;
