import { ConnectorError } from '../errors';
import type { FetchFn } from '../lib/index';
import type { Connector, ConnectorContext, ConnectorInfo } from '../types';
import { MS_CHANNEL_SCOPES, msConfigFromEnv, type MicrosoftConfig } from './config';
import { fakeGraphFetch, fakeMsAuthUrl } from './fake';
import { defaultFakeMsStore, type FakeMicrosoftStore } from './fake-store';
import { graphFor, PROVIDER } from './graph';
import type { MsRecord } from './graph-types';
import { microsoftAccepts, normalizeMicrosoft } from './normalize';
import { msAuthUrl, msExchange } from './oauth';
import { findOutlookSent, sendOutlook } from './send';
import { createSubscription, deleteSubscription, renewSubscription } from './subscriptions';
import { backfillFor, fetchDeltaFor } from './sync';
import { verifyGraphWebhook } from './webhook';

export const MICROSOFT_INFO: ConnectorInfo = {
  name: 'Microsoft 365',
  covers: 'Outlook, Teams, OneDrive',
  multiAccountNote:
    'Connect each work, school or personal Microsoft account separately; pick "Use another account" at sign-in.',
  sources: [
    {
      id: 'mail',
      label: 'Outlook mail',
      hint: 'Inbox and Sent Items',
      kind: 'email',
      defaultOn: true,
      scopes: ['Mail.Read'],
    },
    {
      id: 'calendar',
      label: 'Calendar',
      hint: 'Events from yesterday to 30 days ahead',
      kind: 'event',
      defaultOn: true,
      scopes: ['Calendars.Read'],
    },
    {
      id: 'teams',
      label: 'Teams chats',
      hint: 'Work or school accounts only',
      kind: 'chat',
      defaultOn: true,
      scopes: ['Chat.Read'],
    },
    {
      id: 'onedrive',
      label: 'OneDrive',
      hint: 'File names and edits, never file contents',
      kind: 'file',
      defaultOn: true,
      scopes: ['Files.Read'],
    },
    {
      id: 'channels',
      label: 'Teams channels',
      hint: 'Needs admin consent (ChannelMessage.Read.All); checked every few minutes',
      kind: 'chat',
      defaultOn: false,
      scopes: [...MS_CHANNEL_SCOPES],
    },
  ],
  options: [],
  writeActions: ['outlook.send'],
};

const DEFAULT_ON = Object.fromEntries(MICROSOFT_INFO.sources.map((s) => [s.id, s.defaultOn]));

export type MicrosoftConnectorOptions = {
  /** Defaults to process.env on every call (MS_*, PUBLIC_GATEWAY_URL, CONNECTORS_FAKE). */
  config?: MicrosoftConfig | (() => MicrosoftConfig);
  /** Fake-mode store; defaults to <repo>/.dev/fake-microsoft.json. */
  fakeStore?: FakeMicrosoftStore;
  /** Overrides fetch (tests replay recorded Graph responses with mockFetch). */
  fetch?: FetchFn;
  now?: () => number;
};

export function createMicrosoftConnector(
  opts: MicrosoftConnectorOptions = {},
): Connector<MsRecord> {
  const fakeFetches = new WeakMap<FakeMicrosoftStore, FetchFn>();
  const store = () => opts.fakeStore ?? defaultFakeMsStore();

  const cfg = (): MicrosoftConfig => {
    const base =
      typeof opts.config === 'function' ? opts.config() : (opts.config ?? msConfigFromEnv());
    const c: MicrosoftConfig = { ...base };
    if (opts.now) c.now = opts.now;
    if (opts.fetch) c.fetch = opts.fetch;
    if (c.fake) {
      c.clientId ??= 'fake-client';
      c.clientSecret ??= 'fake-secret';
      if (!c.fetch) {
        const s = store();
        let f = fakeFetches.get(s);
        if (!f) {
          f = fakeGraphFetch(s, c.now ? { now: c.now } : {});
          fakeFetches.set(s, f);
        }
        c.fetch = f;
      }
    }
    return c;
  };
  const sourceOf = (ctx: ConnectorContext) => ctx.source ?? 'mail';
  const read = (c: MicrosoftConfig, ctx: ConnectorContext) => graphFor(c, ctx, 'read');

  const connector: Connector<MsRecord> = {
    provider: 'microsoft',
    info: MICROSOFT_INFO,
    configured() {
      const c = cfg();
      return c.fake || (!!c.clientId && !!c.clientSecret);
    },

    connect: {
      authUrl(o) {
        const c = cfg();
        return c.fake ? fakeMsAuthUrl(store(), o) : msAuthUrl(c, o);
      },
      exchange: (o) => msExchange(cfg(), o),
      /**
       * Microsoft has no per-app token revocation for delegated grants (revokeSignInSessions
       * signs the user out everywhere). Forgetting the tokens is the disconnect; the user
       * can remove the app at myapps.microsoft.com or account.live.com/consent/Manage.
       */
      async revoke() {},
    },

    async subscribe(ctx) {
      const c = cfg();
      return createSubscription(c, read(c, ctx), ctx);
    },
    async renew(ctx) {
      const c = cfg();
      return renewSubscription(c, read(c, ctx), ctx);
    },
    async unsubscribe(ctx) {
      const c = cfg();
      await deleteSubscription(read(c, ctx), ctx);
    },

    async verifyWebhook(req) {
      return verifyGraphWebhook(req, cfg().now?.() ?? Date.now());
    },

    async fetchDelta(ctx) {
      const c = cfg();
      return fetchDeltaFor(sourceOf(ctx), { cfg: c, graph: read(c, ctx), ctx });
    },

    async backfill(ctx, { days, pageToken }) {
      const c = cfg();
      return backfillFor(sourceOf(ctx), { cfg: c, graph: read(c, ctx), ctx }, days, pageToken);
    },

    normalize: normalizeMicrosoft,

    accepts: (item, filters, source) => microsoftAccepts(item, filters, source, DEFAULT_ON),

    /** Sends with the write-consent (Mail.Send) token in ctx. */
    async execute(ctx, action, payload, idempotencyKey) {
      if (action !== 'outlook.send') {
        throw new ConnectorError(PROVIDER, `unsupported action ${action}`);
      }
      const c = cfg();
      return sendOutlook(graphFor(c, ctx, 'write'), payload, idempotencyKey);
    },

    /** Call with the *read* token context: Mail.Send cannot search Sent Items. */
    async findExecuted(ctx, action, idempotencyKey) {
      if (action !== 'outlook.send') return null;
      const c = cfg();
      return findOutlookSent(read(c, ctx), idempotencyKey);
    },
  };
  return connector;
}
