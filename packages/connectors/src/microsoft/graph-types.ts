/**
 * The subset of Microsoft Graph v1.0 shapes this connector reads. Field names match Graph
 * exactly so recorded responses can be used as fixtures.
 */

export type GraphEmailAddress = { name?: string | null; address?: string | null };
export type GraphRecipient = { emailAddress?: GraphEmailAddress | null };
export type GraphItemBody = { contentType?: string | null; content?: string | null };
export type GraphIdentity = {
  id?: string | null;
  displayName?: string | null;
  email?: string | null;
  userIdentityType?: string | null;
};
export type GraphIdentitySet = {
  user?: GraphIdentity | null;
  application?: GraphIdentity | null;
  device?: GraphIdentity | null;
};

export type Removed = { '@removed'?: { reason?: string } };

export type GraphMessage = Removed & {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: GraphItemBody | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  conversationId?: string | null;
  internetMessageId?: string | null;
  webLink?: string | null;
  parentFolderId?: string | null;
  isDraft?: boolean | null;
  categories?: string[] | null;
  inferenceClassification?: string | null;
  importance?: string | null;
  singleValueExtendedProperties?: { id: string; value: string }[];
};

export type GraphDateTimeTimeZone = { dateTime?: string | null; timeZone?: string | null };

export type GraphEvent = Removed & {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: GraphItemBody | null;
  start?: GraphDateTimeTimeZone | null;
  end?: GraphDateTimeTimeZone | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  isOrganizer?: boolean | null;
  organizer?: GraphRecipient | null;
  attendees?: (GraphRecipient & { type?: string; status?: { response?: string } })[] | null;
  location?: { displayName?: string | null } | null;
  webLink?: string | null;
  seriesMasterId?: string | null;
  type?: string | null;
  iCalUId?: string | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  responseStatus?: { response?: string | null } | null;
};

export type GraphChat = {
  id: string;
  topic?: string | null;
  chatType?: string | null;
  webUrl?: string | null;
  createdDateTime?: string | null;
  lastUpdatedDateTime?: string | null;
  lastMessagePreview?: {
    id?: string | null;
    createdDateTime?: string | null;
    from?: GraphIdentitySet | null;
  } | null;
};

export type GraphChatMessage = {
  id: string;
  replyToId?: string | null;
  messageType?: string | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  deletedDateTime?: string | null;
  subject?: string | null;
  chatId?: string | null;
  channelIdentity?: { teamId?: string | null; channelId?: string | null } | null;
  webUrl?: string | null;
  from?: GraphIdentitySet | null;
  body?: GraphItemBody | null;
  mentions?:
    { id?: number; mentionText?: string | null; mentioned?: GraphIdentitySet | null }[] | null;
};

export type GraphDriveItem = {
  id: string;
  name?: string | null;
  webUrl?: string | null;
  size?: number | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  file?: { mimeType?: string | null } | null;
  folder?: { childCount?: number | null } | null;
  root?: Record<string, unknown> | null;
  deleted?: { state?: string | null } | null;
  parentReference?: { driveId?: string | null; id?: string | null; path?: string | null } | null;
  createdBy?: GraphIdentitySet | null;
  lastModifiedBy?: GraphIdentitySet | null;
};

export type GraphUser = {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
};

export type GraphCollection<T> = {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

export type GraphSubscription = {
  id: string;
  resource?: string;
  changeType?: string;
  expirationDateTime: string;
  clientState?: string | null;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string | null;
};

/** One entry of a changeNotificationCollection (change or lifecycle notification). */
export type GraphChangeNotification = {
  id?: string;
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  changeType?: string;
  clientState?: string | null;
  resource?: string;
  tenantId?: string;
  lifecycleEvent?: string;
  resourceData?: {
    id?: string;
    '@odata.type'?: string;
    '@odata.id'?: string;
    '@odata.etag'?: string;
  } | null;
};

/** The account owner, carried on every record so normalize can set `fromMe`. */
export type MsOwner = { id: string; addresses: string[] };

/** What fetchDelta/backfill return, one variant per source. */
export type MsRecord =
  | { source: 'mail'; folder: 'inbox' | 'sent'; message: GraphMessage; owner: MsOwner }
  | { source: 'calendar'; event: GraphEvent; owner: MsOwner }
  | {
      source: 'teams' | 'channels';
      chat: Pick<GraphChat, 'id' | 'topic' | 'chatType' | 'webUrl'> & {
        teamId?: string;
        channelId?: string;
      };
      message: GraphChatMessage;
      owner: MsOwner;
    }
  | { source: 'onedrive'; item: GraphDriveItem; owner: MsOwner };
