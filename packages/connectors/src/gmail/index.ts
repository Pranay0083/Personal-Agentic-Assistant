import { createGmailConnector } from './connector';

export { createGmailConnector, type GmailConnectorOptions } from './connector';
export { GMAIL_SCOPES, gmailConfigFromEnv, type GmailConfig } from './config';
export {
  mapGmailError,
  realClientFactory,
  type GmailApi,
  type GmailClientFactory,
  type GmailMessage,
} from './client';
export {
  normalizeGmail,
  rfc822MessageId,
  RFC822_LABEL_PREFIX,
  extractBody,
  htmlToText,
  parseAddress,
  gmailWebUrl,
  type GmailRecord,
} from './normalize';
export { gmailAccepts, watchLabelIds, backfillQuery } from './filters';
export { buildMime, messageIdFor, rfc822SearchId } from './mime';
export {
  createPubSubVerifier,
  PubSubPush,
  GmailNotification,
  type OidcVerifier,
  type PubSubVerifierOptions,
} from './pubsub';
export {
  FakeGmailStore,
  defaultFakeStore,
  seedFakeState,
  DEFAULT_FAKE_STORE_PATH,
} from './fake-store';
export { fakeClientFactory, fakeAuth, FakeHttpError } from './fake';

/** The default Gmail connector: configured from process.env on each call. */
export const gmail = createGmailConnector();
