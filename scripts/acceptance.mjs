// Acceptance checks for Phases 1-4, run against the local dev stack in demo mode.
//
//   docker compose up -d && pnpm db:migrate
//   pnpm dev > .dev/dev.log 2>&1 &      # with GMAIL_FAKE=1, MODEL_PROVIDER=fake, PUSH_FAKE=1, DEV_AUTH=1
//   pnpm acceptance
//
// Creates a user alex@example.com (and mallory@example.com for the cross-user check) in the dev DB.
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:4000';
const MCP = 'http://localhost:4002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36).slice(-4);
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
};

let token = '';
const api = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-timezone': 'Asia/Kolkata',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const fakeEmail = (to, from, subject, body) =>
  execSync(
    `pnpm --filter @hub/gateway fake:email --to ${to} --from ${JSON.stringify(from)} --subject ${JSON.stringify(subject)} --body ${JSON.stringify(body)}`,
    { cwd: REPO, stdio: 'pipe' },
  );
const sentCount = (mailbox) => {
  const s = JSON.parse(readFileSync(`${REPO}/.dev/fake-gmail.json`, 'utf8'));
  return Object.values(s.mailboxes[mailbox].messages).filter((m) =>
    (m.labelIds ?? []).includes('SENT'),
  ).length;
};

// Follows the OAuth redirects like the phone's auth session, then completes with our session.
async function connect(path) {
  const { json } = await api('POST', path, {});
  let url = json.url;
  for (let i = 0; i < 5 && !url.startsWith('hub:'); i++) {
    const r = await fetch(url, { redirect: 'manual' });
    url = new URL(r.headers.get('location'), url).toString();
  }
  const pending = new URL(url).searchParams.get('pending');
  return { pending, done: pending ? await api('POST', '/accounts/complete', { pending }) : null };
}

// ---- Phase 1 ----
token = (await api('POST', '/auth/dev', { email: 'alex@example.com', name: 'Alex' })).json.token;
// The fake OAuth hands out fixture mailboxes round-robin, so pick accounts by address.
const connected = [
  (await connect('/accounts/gmail/connect')).done.json.account,
  (await connect('/accounts/gmail/connect')).done.json.account,
];
const work = connected.find((a) => a.externalId === 'alex@company.example');
const personal = connected.find((a) => a.externalId === 'alex.personal@gmail.example');
check(
  'connect two Gmail accounts',
  work.externalId !== personal.externalId,
  `${work.externalId}, ${personal.externalId}`,
);

// M1: a flow started by someone else can't be completed into their account.
const mine = token;
token = (await api('POST', '/auth/dev', { email: 'mallory@example.com' })).json.token;
const stolen = await (async () => {
  token = (await api('POST', '/auth/dev', { email: 'mallory@example.com' })).json.token;
  const { json } = await api('POST', '/accounts/gmail/connect', {});
  let url = json.url;
  for (let i = 0; i < 5 && !url.startsWith('hub:'); i++) {
    const r = await fetch(url, { redirect: 'manual' });
    url = new URL(r.headers.get('location'), url).toString();
  }
  token = mine; // the victim's app finishes the flow
  return api('POST', '/accounts/complete', { pending: new URL(url).searchParams.get('pending') });
})();
check(
  'flow started by another user is refused (M1)',
  stolen.status === 403,
  `${stolen.status} ${stolen.json?.error}`,
);

await api('PATCH', `/accounts/${work.id}`, {
  nickname: 'Work',
  isPersonal: false,
  backfillDays: 7,
});
await api('PATCH', `/accounts/${personal.id}`, {
  nickname: 'Personal',
  isPersonal: true,
  backfillDays: 7,
});
await api('PATCH', '/me', { settings: { notificationsEnabled: true } });
await api('POST', '/me/push-tokens', { token: 'ExponentPushToken[e2e]', platform: 'ios' });
await sleep(3000);
const t0 = Date.now();
fakeEmail(
  work.externalId,
  'Meera Iyer <meera@company.example>',
  'Board pack ' + RUN,
  'Hi Alex, could you send me the board pack by Wednesday? Thanks, Meera',
);
fakeEmail(
  personal.externalId,
  'City Dental <front@citydental.example>',
  'Follow-up visit ' + RUN,
  'Please book your follow-up appointment by next Monday.',
);
const both = await until(async () => {
  const { json } = await api('GET', '/items?limit=100');
  const hit = json.items.filter((i) =>
    ['Board pack ' + RUN, 'Follow-up visit ' + RUN].includes(i.title),
  );
  return hit.length === 2 ? hit : null;
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
check('both emails in the Inbox within a minute', !!both, `${secs}s`);
check(
  'each tagged with the right account',
  !!both &&
    both.find((i) => i.title === 'Board pack ' + RUN).accountId === work.id &&
    both.find((i) => i.title === 'Follow-up visit ' + RUN).accountId === personal.id,
);

// ---- Phase 2 ----
const task = await until(async () =>
  (await api('GET', '/tasks?status=open')).json.tasks.find((t) => /board pack/i.test(t.title)),
);
const due =
  task &&
  new Date(task.dueAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
check(
  'dated request becomes a task with that due date',
  !!task && due.startsWith('Wed'),
  `${task?.title} · ${due}`,
);
const log = readFileSync(process.env.DEVLOG ?? `${REPO}/.dev/dev.log`, 'utf8');
const pushes = log
  .split('\n')
  .filter((l) => l.includes('"name":"notifier"') && l.includes('push (fake)'));
check('push notification sent', pushes.length > 0, `${pushes.length} pushes`);
check(
  'push text carries no message content (M4)',
  pushes.every((l) => !/board pack|meera|dental/i.test(l)),
);

// ---- Phase 4 ----
const proposal = await until(async () =>
  (await api('GET', '/proposals?status=pending')).json.proposals.find(
    (p) => p.accountId === work.id,
  ),
);
check(
  'reply agent drafted a proposal to the real sender',
  proposal?.payload.to.join() === 'meera@company.example',
  proposal?.title,
);
await connect(`/accounts/${work.id}/write-access`);
const before = sentCount(work.externalId);
const ok = await api('POST', `/proposals/${proposal.id}/approve`, {});
const again = await api('POST', `/proposals/${proposal.id}/approve`, {});
check('approve accepted once, second approve 409', ok.status === 200 && again.status === 409);
const executed = await until(async () =>
  (await api('GET', '/proposals')).json.proposals.find(
    (p) => p.id === proposal.id && p.status === 'executed',
  ),
);
check(
  'executor sent it',
  !!executed && sentCount(work.externalId) === before + 1,
  `sent ${before} -> ${sentCount(work.externalId)}`,
);
execSync(
  `psql -h localhost -p 5434 -U hub -d hub -c "update proposals set status='executing', executed_at=null where id='${proposal.id}'"`,
  { env: { ...process.env, PGPASSWORD: 'hub' }, stdio: 'pipe' },
);
const { writeFileSync, unlinkSync } = await import('node:fs');
const tmp = `${REPO}/apps/workers/.e2e-enqueue.ts`;
writeFileSync(
  tmp,
  `import {enqueue,closeQueues,env} from '@hub/server'; env(); await enqueue('executor',{proposalId:'${proposal.id}'},{jobId:'e2e-crash-${Date.now()}'}); await closeQueues();`,
);
try {
  execSync(`pnpm exec tsx "${tmp}"`, { cwd: `${REPO}/apps/workers`, stdio: 'pipe' });
} finally {
  unlinkSync(tmp);
}
await until(
  async () =>
    (await api('GET', '/proposals')).json.proposals.find(
      (p) => p.id === proposal.id && p.status === 'executed',
    ),
  30000,
);
check('retry after simulated crash does not re-send', sentCount(work.externalId) === before + 1);

await api('POST', '/control/pause');
fakeEmail(
  work.externalId,
  'Meera Iyer <meera@company.example>',
  'Budget sheet ' + RUN,
  'Can you send me the budget sheet by Friday?',
);
await sleep(6000);
const paused = (await api('GET', '/items?limit=100')).json.items.find(
  (i) => i.title === 'Budget sheet ' + RUN,
);
check('paused: event still syncs, agents do nothing', !!paused && paused.bucket === null);
await api('POST', '/control/resume');
const resumed = await until(async () =>
  (await api('GET', '/items?limit=100')).json.items.find(
    (i) => i.title === 'Budget sheet ' + RUN && i.bucket,
  ),
);
check('resume triages what arrived while paused', !!resumed, resumed?.bucket);

// ---- Phase 3 ----
const reg = await fetch(`${MCP}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost:33418/callback'],
    token_endpoint_auth_method: 'none',
  }),
}).then((r) => r.json());
const verifier = randomBytes(32).toString('base64url');
const q = new URLSearchParams({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: 'http://localhost:33418/callback',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  state: 's',
  resource: `${MCP}/mcp`,
});
const page = await fetch(`${MCP}/authorize?${q}`).then((r) => r.text());
const action = /<form method="post" action="([^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
const hidden = Object.fromEntries(
  [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
    m[1],
    m[2].replace(/&amp;/g, '&'),
  ]),
);
const wait = await fetch(new URL(action, MCP), {
  method: 'POST',
  body: new URLSearchParams({ ...hidden, hub_email: 'alex@example.com' }),
}).then((r) => r.text());
const code = /id="pairing-code"[^>]*>([^<]+)</.exec(wait)?.[1].replace(/\s/g, '');
const cfg = JSON.parse(/(\{"url":[^<]+\})/.exec(wait)[1].replace(/\\u003c/g, '<'));
const req = (await api('GET', '/access-requests?status=pending')).json.requests.find(
  (r) => r.kind === 'mcp_connect',
);
check(
  'connect request on the phone, name marked unverified',
  req?.clientNameVerified === false,
  `${req?.clientName} → ${req?.redirectHost}`,
);
const noCode = await api('POST', `/access-requests/${req.id}/allow`, { durationMinutes: 60 });
check('allow without the pairing code is refused (M3)', noCode.status === 400, noCode.json?.error);
await api('POST', `/access-requests/${req.id}/allow`, { durationMinutes: 60, pairingCode: code });
const st = await fetch(new URL(cfg.url, MCP), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ t: cfg.t }),
}).then((r) => r.json());
const tok = await fetch(`${MCP}/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: new URL(st.redirect).searchParams.get('code'),
    code_verifier: verifier,
    client_id: reg.client_id,
    redirect_uri: 'http://localhost:33418/callback',
    resource: `${MCP}/mcp`,
  }),
}).then((r) => r.json());
check('MCP client connected after phone approval with code', !!tok.access_token);

let id = 0;
const rpc = async (method, params) => {
  const r = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const t = await r.text();
  return JSON.parse(
    t.startsWith('{')
      ? t
      : t
          .split('\n')
          .find((l) => l.startsWith('data:'))
          .slice(5),
  );
};
const tool = async (name, args) =>
  (await rpc('tools/call', { name, arguments: args })).result.content.map((c) => c.text).join('\n');
await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '1' },
});
const workHits = await tool('search_context', { query: 'board' });
check(
  'MCP search reads work context (fenced)',
  /Found [1-9]/.test(workHits) && /<untrusted-/.test(workHits),
);
const personalHits = await tool('search_context', { query: 'follow' });
check('MCP denied personal Gmail', /Found 0/.test(personalHits) && /Withheld/.test(personalHits));
await tool('request_access', {
  accountId: personal.id,
  resource: 'email',
  reason: 'Find the dentist thread',
  durationMinutes: 60,
});
const ar = (await api('GET', '/access-requests?status=pending')).json.requests.find(
  (r) => r.kind === 'access',
);
check(
  'temporary access request shows up on the phone',
  !!ar,
  ar && `${ar.resource} · ${ar.durationMinutes} min`,
);
await api('POST', `/access-requests/${ar.id}/allow`, { durationMinutes: 60 });
check(
  'after "Allow 1 hour" the personal item is readable',
  /Found [1-9]/.test(await tool('search_context', { query: 'follow' })),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
