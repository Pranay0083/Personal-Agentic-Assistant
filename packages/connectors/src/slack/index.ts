import { createSlackConnector } from './connector';

export {
  createSlackConnector,
  SLACK_INFO,
  SLACK_SOURCE,
  HUB_EVENT_TYPE,
  type SlackConnectorOptions,
} from './connector';
export {
  SLACK_READ_SCOPES,
  SLACK_WRITE_SCOPES,
  FAKE_SIGNING_SECRET,
  slackConfigFromEnv,
  type SlackConfig,
} from './config';
export { slackCheckBody, type SlackMessage } from './api';
export {
  normalizeSlack,
  slackAccepts,
  slackOptions,
  slackToText,
  SLACK_LABEL,
  HUB_LABEL,
  type SlackRecord,
  type SlackOptions,
  type ConversationType,
} from './normalize';
export { checkSlackSignature, slackSignature, mapSlackBody, MAX_SKEW_SECONDS } from './webhook';
export { decodeCursor, encodeCursor, type DeltaCursor } from './delta';

/** The default Slack connector: configured from process.env on each call. */
export const slack = createSlackConnector();
