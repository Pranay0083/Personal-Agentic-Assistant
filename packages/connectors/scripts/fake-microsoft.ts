/**
 * Offline demo helper (CONNECTORS_FAKE=1 or MS_FAKE=1 only): adds a mail, Teams chat
 * message or OneDrive change to a fake Microsoft 365 user and POSTs the matching Graph
 * change notification to the gateway, signed with the clientState of the fake
 * subscription the sync worker created.
 *
 *   pnpm --filter @hub/connectors fake:microsoft --kind mail --subject "Slides?" --body "By Thursday?"
 *   pnpm --filter @hub/connectors fake:microsoft --kind teams --body "Can you join the call?"
 *   pnpm --filter @hub/connectors fake:microsoft --kind file --file-name "Plan.docx"
 *   pnpm --filter @hub/connectors fake:microsoft --user sam.rivera@outlook.example --kind mail
 *   pnpm --filter @hub/connectors fake:microsoft --lifecycle reauthorizationRequired --kind mail
 *   pnpm --filter @hub/connectors fake:microsoft --list
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_FAKE_MS_PATH,
  defaultFakeMsStore,
  type FakeMicrosoftStore,
} from '../src/microsoft/fake-store';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const on = (v: string | undefined) => v === '1' || v === 'true';
if (
  !(on(process.env.CONNECTORS_FAKE) || on(process.env.MS_FAKE)) ||
  process.env.NODE_ENV === 'production'
) {
  console.error('fake:microsoft needs CONNECTORS_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    kind: { type: 'string', default: 'mail' },
    from: { type: 'string', default: 'priya.raman@contoso.example' },
    'from-name': { type: 'string', default: 'Priya Raman' },
    subject: { type: 'string', default: 'Quick question' },
    body: { type: 'string', default: 'Could you send me the Q3 numbers by Friday?' },
    html: { type: 'boolean', default: false },
    chat: { type: 'string' },
    'file-name': { type: 'string', default: 'Q3 Board Deck.pptx' },
    lifecycle: { type: 'string' },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const store: FakeMicrosoftStore = defaultFakeMsStore();

if (values.list) {
  const state = store.read();
  for (const key of store.keys()) {
    const u = store.user(key)!;
    const subs = Object.values(state.subscriptions).filter((s) => s.userKey === key);
    console.log(
      `${u.upn}  (${u.nickname}${u.personal ? ', personal MSA' : ''}; ${u.messages.length} mails, ` +
        `${u.chatMessages.length} chat messages, ${u.driveItems.length} files; ` +
        `subscriptions: ${subs.map((s) => s.resource).join(', ') || 'none yet'})`,
    );
  }
  console.log(`store: ${DEFAULT_FAKE_MS_PATH()}`);
  process.exit(0);
}

const key = (values.user ?? store.keys()[0]!).toLowerCase();
const user = store.user(key);
if (!user) {
  console.error(`no fake Microsoft user ${key}. Known: ${store.keys().join(', ')}`);
  process.exit(1);
}

type Note = Record<string, unknown>;
const kind = values.kind!;
const RESOURCE_MATCH: Record<string, (r: string) => boolean> = {
  mail: (r) => /\/messages$/i.test(r) && !/chats/i.test(r),
  teams: (r) => /getAllMessages/i.test(r),
  file: (r) => /drive/i.test(r),
};
const matcher = RESOURCE_MATCH[kind];
if (!matcher) {
  console.error(`--kind must be one of ${Object.keys(RESOURCE_MATCH).join(', ')}`);
  process.exit(1);
}

let notification: Note;
if (values.lifecycle) {
  notification = { lifecycleEvent: values.lifecycle };
  console.log(`sending lifecycle ${values.lifecycle} for ${kind} of ${user.upn}`);
} else if (kind === 'mail') {
  const m = store.addMail(key, {
    from: values.from!,
    fromName: values['from-name']!,
    subject: values.subject!,
    body: values.body!,
    html: values.html!,
  });
  const res = `Users/${user.id}/Messages/${m.id}`;
  notification = {
    changeType: 'created',
    resource: res,
    resourceData: {
      '@odata.type': '#Microsoft.Graph.Message',
      '@odata.id': res,
      '@odata.etag': `W/"${Date.now()}"`,
      id: m.id,
    },
  };
  console.log(`delivered mail ${m.id} to ${user.upn}`);
} else if (kind === 'teams') {
  const { chat, message } = store.addChatMessage(key, {
    ...(values.chat ? { chatId: values.chat } : {}),
    fromName: values['from-name']!,
    text: values.body!,
  });
  const res = `chats('${chat.id}')/messages('${message.id}')`;
  notification = {
    changeType: 'created',
    resource: res,
    resourceData: {
      id: message.id,
      '@odata.type': '#Microsoft.Graph.chatMessage',
      '@odata.id': res,
    },
  };
  console.log(`posted Teams message ${message.id} in ${chat.topic ?? chat.id}`);
} else {
  const item = store.addDriveChange(key, {
    name: values['file-name']!,
    byName: values['from-name']!,
  });
  notification = { changeType: 'updated', resource: '/me/drive/root' };
  console.log(`changed OneDrive file ${item.name} (${item.id})`);
}

if (values['no-push']) process.exit(0);

const sub = store.findSubscription(key, matcher);
if (!sub) {
  console.log(
    `no fake ${kind} subscription for ${user.upn} yet: connect the account and let a sync run, ` +
      'then retry. The change is stored and the next scheduled sync will pick it up.',
  );
  process.exit(0);
}

const body = {
  value: [
    {
      subscriptionId: sub.id,
      subscriptionExpirationDateTime: sub.expirationDateTime,
      clientState: sub.clientState,
      tenantId: user.tenantId,
      ...notification,
    },
  ],
};
const gateway = (
  values.gateway ??
  process.env.PUBLIC_GATEWAY_URL ??
  'http://localhost:4001'
).replace(/\/$/, '');
const url = `${gateway}/hooks/microsoft`;
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`POST ${url} → ${res.status}`);
  if (!res.ok) process.exitCode = 1;
} catch (e) {
  console.error(`could not reach the gateway at ${url}: ${(e as Error).message}`);
  process.exitCode = 1;
}
