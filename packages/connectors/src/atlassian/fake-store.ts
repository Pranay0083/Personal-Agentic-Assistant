import { defaultFakePath, fixture, JsonFileStore, MemoryStore, type Store } from '../lib/fake';

/**
 * State of the fake Atlassian (CONNECTORS_FAKE=1): one user who can see two sites from
 * one consent. Stored compactly (people by account id); the fake API expands it into the
 * real response shapes. Shared by the api, gateway, workers and the fake:atlassian script
 * through <repo>/.dev/fake-atlassian.json.
 */

export type FakePerson = { displayName: string; emailAddress?: string };

export type FakeComment = {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: unknown;
  properties?: { key: string; value: unknown }[];
};

export type FakeIssue = {
  id: string;
  key: string;
  watchers: string[];
  properties?: Record<string, unknown>;
  fields: {
    summary: string;
    status: { id?: string; name: string; statusCategory: { key: string; name?: string } };
    priority: { id?: string; name: string } | null;
    assignee: string | null;
    reporter: string | null;
    issuetype: { name: string };
    project: { key: string; name?: string };
    created: string;
    updated: string;
    description: unknown;
    issuelinks: unknown[];
    comment: { comments: FakeComment[] };
  };
};

export type FakePage = {
  id: string;
  type: 'page';
  status: string;
  title: string;
  space: { key: string; name?: string };
  history: { createdBy: string; createdDate: string };
  version: { when: string; number: number; by: string };
  watchers?: string[];
  mentions?: string[];
  body: { storage: { value: string; representation: string } };
  _links: { webui: string; tinyui?: string };
};

export type FakeWebhook = {
  id: number;
  url: string;
  jqlFilter: string;
  events: string[];
  expirationDate: string;
};

export type FakeSite = {
  cloudId: string;
  name: string;
  url: string;
  products: ('jira' | 'confluence')[];
  issues: FakeIssue[];
  pages: FakePage[];
  webhooks?: FakeWebhook[];
};

export type FakeAtlassianState = {
  user: {
    account_id: string;
    email: string;
    name: string;
    nickname?: string;
    account_status?: string;
  };
  people: Record<string, FakePerson>;
  sites: FakeSite[];
  /** Set to make every token fail (the "reconnect" flow). A fresh consent clears it. */
  revoked?: boolean;
  nextId?: number;
};

const JIRA_TS = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');

/** Seed from the fixture, shifted so the newest record is a few minutes old. */
export function seedFakeAtlassian(now = Date.now()): FakeAtlassianState {
  const s = fixture<FakeAtlassianState>(import.meta.url, 'fake-state.json');
  const times: number[] = [];
  for (const site of s.sites) {
    for (const i of site.issues) times.push(Date.parse(fixTz(i.fields.updated)));
    for (const p of site.pages) times.push(Date.parse(p.version.when));
  }
  const shift = now - 5 * 60_000 - Math.max(...times);
  const j = (t: string) => JIRA_TS(Date.parse(fixTz(t)) + shift);
  const c = (t: string) => new Date(Date.parse(t) + shift).toISOString();
  for (const site of s.sites) {
    site.webhooks = [];
    for (const i of site.issues) {
      i.properties = {};
      i.fields.created = j(i.fields.created);
      i.fields.updated = j(i.fields.updated);
      for (const cm of i.fields.comment.comments) {
        cm.created = j(cm.created);
        cm.updated = j(cm.updated);
      }
    }
    for (const p of site.pages) {
      p.history.createdDate = c(p.history.createdDate);
      p.version.when = c(p.version.when);
    }
  }
  s.nextId = 40000;
  return s;
}

const fixTz = (s: string) => s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
export const jiraTimestamp = JIRA_TS;

export const DEFAULT_FAKE_STORE_PATH = () =>
  process.env.ATLASSIAN_FAKE_STORE ?? defaultFakePath('atlassian');

export class FakeAtlassianStore {
  constructor(readonly store: Store<FakeAtlassianState>) {}

  read() {
    return this.store.read();
  }

  update<R>(fn: (s: FakeAtlassianState) => R): R {
    return this.store.update(fn);
  }

  site(s: FakeAtlassianState, cloudId: string): FakeSite | undefined {
    return s.sites.find((x) => x.cloudId === cloudId);
  }

  /** Finds an issue by key on any site. */
  findIssue(key: string): { site: FakeSite; issue: FakeIssue } | null {
    for (const site of this.read().sites) {
      const issue = site.issues.find((i) => i.key === key);
      if (issue) return { site, issue };
    }
    return null;
  }
}

export function memoryFakeStore(now?: number) {
  return new FakeAtlassianStore(new MemoryStore(() => seedFakeAtlassian(now)));
}

let shared: FakeAtlassianStore | null = null;
export function defaultFakeStore(): FakeAtlassianStore {
  shared ??= new FakeAtlassianStore(
    new JsonFileStore(DEFAULT_FAKE_STORE_PATH(), () => seedFakeAtlassian()),
  );
  return shared;
}
