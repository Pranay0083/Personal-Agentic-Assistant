/**
 * Offline demo helper (GMAIL_FAKE=1 or CONNECTORS_FAKE=1 only). Adds a Google Chat message,
 * a Calendar invite or a Drive share to a fake account, then POSTs the push Google would
 * send, so the gateway → sync worker pipeline picks it up:
 * - calendar / drive: a watch-channel notification to /hooks/gmail/channel (headers only,
 *   with the channel token the connector registered when it subscribed);
 * - chat: a Workspace Events CloudEvent in a Pub/Sub envelope to /hooks/gmail/events.
 *
 *   pnpm --filter @hub/connectors fake:google --kind chat --to alex@company.example \
 *     --text "Can you review the launch plan?" [--space "Launch team"] [--mention]
 *   pnpm --filter @hub/connectors fake:google --kind calendar --to alex@company.example \
 *     --title "Budget sync" [--from "Priya Raman <priya@company.example>"] [--start 2026-10-02T10:00:00Z]
 *   pnpm --filter @hub/connectors fake:google --kind drive --to alex@company.example \
 *     --title "Launch plan" [--from "Sam Ortiz <sam@company.example>"]
 *   pnpm --filter @hub/connectors fake:google --list
 *
 * The account must be connected with the source on (the sync worker subscribes it), or
 * there is no channel/subscription to push to; the item then arrives on the next
 * scheduled sync. Prints ids only, never the text.
 */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FAKE_STORE_PATH, defaultFakeStore, repoRoot } from '../src/gmail/fake-store';
import { fakeMode } from '../src/lib/fake';

const envFile = path.join(repoRoot(), '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Unreadable .env: rely on the process environment.
  }
}

const fake = (() => {
  try {
    return fakeMode('GMAIL_FAKE');
  } catch {
    return false; // NODE_ENV=production
  }
})();
if (!fake) {
  console.error(
    'fake:google needs GMAIL_FAKE=1 or CONNECTORS_FAKE=1 (and never runs in production).',
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    to: { type: 'string' },
    text: { type: 'string' },
    title: { type: 'string' },
    from: { type: 'string' },
    space: { type: 'string' },
    mention: { type: 'boolean', default: false },
    start: { type: 'string' },
    duration: { type: 'string' },
    mime: { type: 'string' },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const store = defaultFakeStore();

if (values.list) {
  for (const email of store.emails()) {
    const g = store.google(email)!;
    const channels = g.channels.map((c) => c.source).join(', ') || 'none';
    const subs = g.eventSubscriptions.length;
    console.log(
      `${email}  (${g.workspace ? 'Workspace' : 'consumer'}; ${g.calendar.events.length} events, ` +
        `${g.drive.changes.length} drive changes, ${g.chat.messages.length} chat messages; ` +
        `channels: ${channels}; chat subscriptions: ${subs})`,
    );
  }
  console.log(`store: ${DEFAULT_FAKE_STORE_PATH()}`);
  process.exit(0);
}

const kind = values.kind;
if (kind !== 'chat' && kind !== 'calendar' && kind !== 'drive') {
  console.error('--kind must be chat, calendar or drive (or use --list)');
  process.exit(1);
}
const to = (values.to ?? store.emails()[0]!).toLowerCase();
const mb = store.mailbox(to);
if (!mb) {
  console.error(`no fake account ${to}. Known: ${store.emails().join(', ')}`);
  process.exit(1);
}

// Accept `--from addr` and `--from "Name <addr>"`.
const fromMatch = values.from ? /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(values.from) : null;
const fromEmail = fromMatch ? fromMatch[2]!.trim() : values.from;
const fromName = fromMatch?.[1]?.trim() || undefined;
const text = values.text ?? values.title;

const gatewayBase = (
  values.gateway ??
  process.env.PUBLIC_GATEWAY_URL ??
  'http://localhost:4001'
).replace(/\/$/, '');

async function post(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { method: 'POST', ...init });
    console.log(`push → ${url}: HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`push → ${url} failed: is the gateway running (pnpm dev)?`);
    process.exitCode = 1;
  }
}

// Google notifies every open channel / subscription on a resource (several Hub accounts
// can watch the same fake mailbox in dev), so the fake does too.
async function pushChannel(source: 'calendar' | 'drive') {
  const open = store
    .google(to)!
    .channels.filter((c) => c.source === source && c.expiration > Date.now());
  if (open.length === 0) {
    console.warn(
      `no open ${source} channel for ${to} (connect the account with ${source} on first); ` +
        'the item arrives on the next scheduled sync.',
    );
    return;
  }
  for (const ch of open) {
    const url = values.gateway ? `${gatewayBase}/hooks/gmail/channel` : ch.address;
    await post(url, {
      headers: {
        'x-goog-channel-id': ch.id,
        'x-goog-channel-token': ch.token,
        'x-goog-channel-expiration': new Date(ch.expiration).toUTCString(),
        'x-goog-message-number': String(Date.now() * 10 + randomInt(10)),
        'x-goog-resource-id': ch.resourceId,
        'x-goog-resource-state': source === 'calendar' ? 'exists' : 'change',
        'x-goog-resource-uri':
          source === 'calendar'
            ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json'
            : 'https://www.googleapis.com/drive/v3/changes?alt=json',
      },
    });
  }
}

async function pushChatEvent(messageName: string, spaceName: string, createTime: string) {
  const subs = store.google(to)!.eventSubscriptions.filter((s) => s.state !== 'DELETED');
  if (subs.length === 0) {
    console.warn(
      `no Workspace Events subscription for ${to} (connect the account with Chat on first); ` +
        'the message arrives on the next scheduled sync.',
    );
    return;
  }
  for (const sub of subs) {
    const messageId = `${Date.now()}${randomInt(100_000, 999_999)}`;
    const envelope = {
      message: {
        attributes: {
          'ce-datacontenttype': 'application/json',
          'ce-id': `${spaceName}/spaceEvents/${messageId}`,
          'ce-source': `//workspaceevents.googleapis.com/${sub.name}`,
          'ce-specversion': '1.0',
          'ce-subject': `//chat.googleapis.com/${spaceName}`,
          'ce-time': createTime,
          'ce-type': 'google.workspace.chat.message.v1.created',
        },
        data: Buffer.from(JSON.stringify({ message: { name: messageName } })).toString('base64'),
        messageId,
        publishTime: new Date().toISOString(),
      },
      subscription: 'projects/hub-fake/subscriptions/workspace-events-push',
    };
    await post(`${gatewayBase}/hooks/gmail/events`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
  }
}

if (kind === 'chat') {
  if (!store.google(to)!.workspace) {
    console.error(`${to} is a consumer account in the fake store: Google Chat is not available.`);
    process.exit(1);
  }
  const { message, space } = store.addChatMessage(to, {
    text: text ?? 'Can you take a look at the launch checklist today?',
    ...(values.space ? { space: values.space } : {}),
    ...(values.mention ? { mentionOwner: true } : {}),
  });
  console.log(`added chat message ${message.name} in ${space.name} for ${to}`);
  if (!values['no-push']) await pushChatEvent(message.name, space.name, message.createTime!);
} else if (kind === 'calendar') {
  const start = values.start ? new Date(values.start) : undefined;
  if (start && Number.isNaN(start.getTime())) {
    console.error('--start must be an ISO date-time');
    process.exit(1);
  }
  const event = store.addCalendarEvent(to, {
    title: text ?? 'Quick sync',
    ...(fromEmail ? { organizerEmail: fromEmail } : {}),
    organizerName: fromName ?? (fromEmail ? undefined : 'Priya Raman'),
    ...(start ? { start } : {}),
    ...(values.duration ? { durationMinutes: Number(values.duration) || 30 } : {}),
  });
  console.log(`added calendar event ${event.id} for ${to}`);
  if (!values['no-push']) await pushChannel('calendar');
} else {
  const change = store.shareDriveFile(to, {
    name: text ?? 'Shared doc',
    ...(fromEmail ? { fromEmail } : {}),
    ...(fromName ? { fromName } : {}),
    ...(values.mime ? { mimeType: values.mime } : {}),
  });
  console.log(`shared drive file ${change.fileId} with ${to}`);
  if (!values['no-push']) await pushChannel('drive');
}
