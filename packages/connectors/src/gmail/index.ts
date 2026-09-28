import { createGmailConnector } from './connector';

export { createGmailConnector, GMAIL_INFO, type GmailConnectorOptions } from './connector';
export { GMAIL_SCOPES, GOOGLE_SCOPES, gmailConfigFromEnv, type GmailConfig } from './config';
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
export { normalizeGoogle, googleAccepts, recordSource, type GoogleRecord } from './records';
export {
  GOOGLE_SOURCES,
  SOURCE_SCOPES,
  READ_SCOPES,
  WRITE_SCOPES,
  checkGrantedScopes,
  type GoogleSource,
} from './scopes';
export { normalizeCalendar, type CalendarEvent, type CalendarRecord } from './calendar';
export { normalizeDrive, type DriveChange, type DriveFile, type DriveRecord } from './drive';
export {
  normalizeChat,
  chatEventsFromPush,
  type ChatMessage,
  type ChatSpace,
  type ChatRecord,
} from './chat';
export {
  channelSecretMatches,
  verifyChannelPush,
  CHANNEL_HOOK_PATH,
  CHANNEL_PREFIX,
} from './channels';
export {
  GOOGLE_API,
  realRestFactory,
  type GoogleRest,
  type GoogleRestFactory,
  type GoogleRequest,
} from './rest';
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
export { fakeRestFactory } from './fake-google';

/** The default Google connector: configured from process.env on each call. */
export const gmail = createGmailConnector();
