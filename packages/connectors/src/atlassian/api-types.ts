/** The subset of Atlassian REST shapes the connector reads. Fixtures follow the full shapes. */

export type AccessibleResource = {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
};

export type AtlassianMe = {
  account_id: string;
  email?: string;
  name?: string;
  nickname?: string;
  account_status?: string;
};

export type JiraUser = {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
};

export type JiraStatus = {
  id?: string;
  name: string;
  statusCategory?: { key: string; name?: string };
};

export type JiraComment = {
  id: string;
  author?: JiraUser;
  body?: unknown;
  created: string;
  updated?: string;
  properties?: { key: string; value: unknown }[];
};

export type JiraIssueLink = {
  id?: string;
  type: { name: string; inward?: string; outward?: string };
  inwardIssue?: { id?: string; key: string; fields?: { status?: JiraStatus } };
  outwardIssue?: { id?: string; key: string; fields?: { status?: JiraStatus } };
};

export type JiraIssue = {
  id: string;
  key: string;
  self?: string;
  fields: {
    summary?: string;
    status?: JiraStatus;
    priority?: { id?: string; name: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    creator?: JiraUser | null;
    issuetype?: { name: string };
    project?: { key: string; name?: string };
    created?: string;
    updated: string;
    description?: unknown;
    issuelinks?: JiraIssueLink[];
    comment?: { comments: JiraComment[]; total?: number; maxResults?: number };
    [k: string]: unknown;
  };
};

export type JiraSearchPage = {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
};

export type WebhookRegistration = {
  webhookRegistrationResult: { createdWebhookId?: number; errors?: string[] }[];
};

export type RegisteredWebhook = {
  id: number;
  jqlFilter: string;
  events: string[];
  expirationDate?: string;
};

export type WebhookList = {
  values: RegisteredWebhook[];
  isLast?: boolean;
  startAt?: number;
  maxResults?: number;
  total?: number;
};

export type ConfluenceContent = {
  id: string;
  type: string;
  status?: string;
  title: string;
  space?: { key: string; name?: string };
  history?: { createdBy?: ConfluenceUser; createdDate?: string };
  version?: { when: string; number: number; by?: ConfluenceUser };
  body?: { storage?: { value: string; representation?: string } };
  _links?: { webui?: string; tinyui?: string; self?: string };
};

export type ConfluenceUser = {
  accountId?: string;
  displayName?: string;
  publicName?: string;
  email?: string;
};

export type ConfluenceSearchPage = {
  results: { content?: ConfluenceContent; title?: string; lastModified?: string }[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: { base?: string; next?: string; context?: string };
};

export type JiraTransitions = {
  transitions: { id: string; name: string; to?: JiraStatus }[];
};
