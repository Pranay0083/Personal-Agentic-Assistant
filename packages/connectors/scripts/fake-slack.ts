/**
 * Offline demo helper (CONNECTORS_FAKE=1 or SLACK_FAKE=1 only). Appends a message to the
 * fake Slack store and POSTs a signed Events API `event_callback` to the gateway, exactly
 * like Slack would (X-Slack-Signature v0 with the literal fake signing secret).
 *
 *   pnpm --filter @hub/connectors fake:slack --list
 *   pnpm --filter @hub/connectors fake:slack --channel launch --from priya --text "<@U0ALEX0001> ready?"
 *   pnpm --filter @hub/connectors fake:slack --channel @priya --text "Got a minute?"      (DM)
 *   pnpm --filter @hub/connectors fake:slack --channel launch --thread last --text "+1"   (reply)
 *   pnpm --filter @hub/connectors fake:slack --team side-project --channel build --text "Green"
 *   pnpm --filter @hub/connectors fake:slack --team acme-eng --revoke   (tokens_revoked event)
 *
 * Prints ids only, never message text.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FAKE_SIGNING_SECRET } from '../src/slack/config';
import {
  DEFAULT_FAKE_SLACK_PATH,
  defaultFakeSlackStore,
  type FakeSlackConversation,
  type FakeWorkspace,
} from '../src/slack/fake';
import { slackSignature } from '../src/slack/webhook';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const on = (v: string | undefined) => v === '1' || v === 'true';
if (
  !(on(process.env.CONNECTORS_FAKE) || on(process.env.SLACK_FAKE)) ||
  process.env.NODE_ENV === 'production'
) {
  console.error('fake:slack needs CONNECTORS_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    team: { type: 'string' },
    channel: { type: 'string' },
    from: { type: 'string' },
    text: { type: 'string', default: 'Can you take a look at this today?' },
    thread: { type: 'string' },
    revoke: { type: 'boolean', default: false },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const store = defaultFakeSlackStore();

if (values.list) {
  for (const w of store.workspaces()) {
    console.log(`${w.team.id}  ${w.team.domain}  "${w.team.name}"  (me: ${w.selfUserId})`);
    for (const c of w.conversations) {
      const label = c.type === 'im' || c.type === 'mpim' ? c.type.toUpperCase() : `#${c.name}`;
      const count = w.messages.filter((m) => m.channel === c.id).length;
      const member = c.members.includes(w.selfUserId) ? '' : '  (not a member)';
      console.log(`  ${c.id}  ${label}  ${count} messages${member}`);
    }
    console.log(`  users: ${w.users.map((u) => `${u.name}=${u.id}`).join(', ')}`);
  }
  console.log(`store: ${DEFAULT_FAKE_SLACK_PATH()}`);
  process.exit(0);
}

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const ws: FakeWorkspace =
  (values.team ? store.workspace(values.team) : store.workspaces()[0]) ??
  fail(`no fake workspace ${values.team}. Try --list.`);

const userRef = (ref: string) =>
  ws.users.find((u) => [u.id.toLowerCase(), u.name.toLowerCase()].includes(ref.toLowerCase()));

function pickChannel(ref: string | undefined): FakeSlackConversation {
  if (!ref) return ws.conversations.find((c) => c.members.includes(ws.selfUserId))!;
  if (ref.startsWith('@')) {
    const u = userRef(ref.slice(1)) ?? fail(`no user ${ref} in ${ws.team.domain}`);
    return (
      ws.conversations.find(
        (c) => c.type === 'im' && c.members.includes(u.id) && c.members.includes(ws.selfUserId),
      ) ?? fail(`no DM with ${ref}`)
    );
  }
  const r = ref.replace(/^#/, '').toLowerCase();
  return (
    ws.conversations.find((c) => c.id.toLowerCase() === r || c.name?.toLowerCase() === r) ??
    fail(`no conversation ${ref} in ${ws.team.domain}. Try --list.`)
  );
}

async function push(body: Record<string, unknown>) {
  if (values['no-push']) return;
  const rawBody = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const base = values.gateway ?? process.env.PUBLIC_GATEWAY_URL ?? 'http://localhost:4001';
  const url = `${base.replace(/\/$/, '')}/hooks/slack`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': slackSignature(FAKE_SIGNING_SECRET, ts, rawBody),
      },
      body: rawBody,
    });
    console.log(`event → ${url}: HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`event → ${url} failed: is the gateway running (pnpm dev)?`);
    process.exitCode = 1;
  }
}

const eventId = () => `Ev${randomBytes(5).toString('hex').toUpperCase()}`;
const envelope = (event: Record<string, unknown>) => ({
  token: 'fake-verification-token',
  team_id: ws.team.id,
  context_team_id: ws.team.id,
  api_app_id: 'A0FAKEHUB1',
  event,
  type: 'event_callback',
  event_id: eventId(),
  event_time: Math.floor(Date.now() / 1000),
  authorizations: [
    { enterprise_id: null, team_id: ws.team.id, user_id: ws.selfUserId, is_bot: false },
  ],
});

if (values.revoke) {
  store.revokeAll(ws.team.id);
  console.log(`revoked every fake token of ${ws.team.id}; reconnect to restore`);
  const ts = `${Math.floor(Date.now() / 1000)}.000000`;
  await push(
    envelope({ type: 'tokens_revoked', tokens: { oauth: [ws.selfUserId], bot: [] }, event_ts: ts }),
  );
  process.exit();
}

const conv = pickChannel(values.channel);
const from = values.from
  ? (userRef(values.from) ?? fail(`no user ${values.from} in ${ws.team.domain}`))
  : (ws.users.find((u) => u.id !== ws.selfUserId && !u.is_bot && conv.members.includes(u.id)) ??
    ws.users[0]!);

let threadTs: string | undefined;
if (values.thread === 'last') {
  const top = ws.messages
    .filter((m) => m.channel === conv.id && (!m.thread_ts || m.thread_ts === m.ts) && !m.subtype)
    .at(-1);
  threadTs = top?.ts ?? fail(`no message to reply to in ${conv.id}`);
} else if (values.thread) {
  threadTs = values.thread;
}

let msg;
try {
  msg = store.appendMessage(ws.team.id, {
    channel: conv.id,
    user: from.id,
    text: values.text!,
    ...(threadTs ? { threadTs } : {}),
  });
} catch (e) {
  fail((e as Error).message);
}
console.log(
  `posted ${conv.id}:${msg!.ts} from ${from.id} in ${ws.team.id}${threadTs ? ` (thread ${threadTs})` : ''}`,
);

await push(
  envelope({
    type: 'message',
    user: from.id,
    text: msg!.text,
    ts: msg!.ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    team: ws.team.id,
    channel: conv.id,
    event_ts: msg!.ts,
    channel_type: conv.type,
  }),
);
