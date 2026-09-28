/**
 * Offline demo helper (GMAIL_FAKE=1 only): delivers a message to a fake mailbox and
 * POSTs a Pub/Sub-shaped push to the gateway, exactly like Gmail + Pub/Sub would.
 *
 *   pnpm --filter @hub/gateway fake:email --to alex@company.example --subject "Slides?" --body "By Thursday?"
 *   pnpm --filter @hub/gateway fake:email --list
 */
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { defaultFakeStore, DEFAULT_FAKE_STORE_PATH } from '@hub/connectors/gmail/fake';
import { env } from '@hub/server';

const e = env();
if (!e.GMAIL_FAKE || e.NODE_ENV === 'production') {
  console.error('fake:email needs GMAIL_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    from: { type: 'string', default: 'priya@company.example' },
    'from-name': { type: 'string', default: 'Priya Raman' },
    subject: { type: 'string', default: 'Quick question' },
    body: { type: 'string', default: 'Could you send me the Q3 numbers by Friday?' },
    html: { type: 'string' },
    label: { type: 'string', multiple: true },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const store = defaultFakeStore();
if (values.list) {
  for (const email of store.emails()) {
    const mb = store.mailbox(email)!;
    console.log(
      `${email}  (${mb.nickname}, historyId ${mb.historyId}, ${mb.messages.length} messages)`,
    );
  }
  console.log(`store: ${DEFAULT_FAKE_STORE_PATH()}`);
  process.exit(0);
}

const to = (values.to ?? store.emails()[0]!).toLowerCase();
if (!store.mailbox(to)) {
  console.error(`no fake mailbox ${to}. Known: ${store.emails().join(', ')}`);
  process.exit(1);
}

const { message, historyId } = store.appendMessage(to, {
  from: values.from!,
  fromName: values['from-name']!,
  subject: values.subject!,
  body: values.body!,
  ...(values.html ? { html: values.html } : {}),
  ...(values.label?.length ? { labelIds: values.label } : {}),
});
console.log(`delivered message ${message.id} to ${to} (historyId ${historyId})`);

if (!values['no-push']) {
  const envelope = {
    message: {
      data: Buffer.from(
        JSON.stringify({ emailAddress: to, historyId: Number(historyId) }),
      ).toString('base64'),
      messageId: `${Date.now()}${randomInt(100_000, 999_999)}`,
      publishTime: new Date().toISOString(),
      attributes: {},
    },
    subscription: 'projects/hub-fake/subscriptions/gmail-push',
  };
  const url = `${(values.gateway ?? e.PUBLIC_GATEWAY_URL).replace(/\/$/, '')}/hooks/gmail`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    console.log(`push → ${url}: HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`push → ${url} failed: is the gateway running (pnpm dev)?`);
    process.exitCode = 1;
  }
}
