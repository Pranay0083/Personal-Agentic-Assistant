// Phase 5 acceptance: every connector end to end against the local dev stack in demo mode.
//
//   CONNECTORS_FAKE=1 (plus the demo flags in README) and `pnpm dev` running, then:
//   pnpm acceptance:connectors
//
// For each provider: connect through the real API OAuth flow (fake consent), let sync
// subscribe, deliver a change with the provider's fake script (a signed webhook through
// the gateway), and check the item lands on the right account with the right signals.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.PUBLIC_API_URL ?? 'http://localhost:4000';
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(700);
  }
};

let token = '';
const api = async (method, p, body) => {
  const r = await fetch(API + p, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-timezone': 'Asia/Kolkata',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const fake = (provider, args) =>
  execFileSync('pnpm', ['--silent', '--filter', '@hub/connectors', `fake:${provider}`, ...args], {
    cwd: REPO,
    stdio: 'pipe',
  }).toString();

async function connect(provider, pathOverride) {
  const { json, status } = await api('POST', pathOverride ?? `/accounts/${provider}/connect`, {});
  if (status !== 200) return { status, json };
  let url = json.url;
  for (let i = 0; i < 6 && !url.startsWith('hub:'); i++) {
    const r = await fetch(url, { redirect: 'manual' });
    url = new URL(r.headers.get('location'), url).toString();
  }
  const pending = new URL(url).searchParams.get('pending');
  return (await api('POST', '/accounts/complete', { pending })).json;
}
/** Fake consent rotates through fixture identities; connect until we get the one we want. */
async function connectUntil(provider, want, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await connect(provider);
    const hit = (res.accounts?.length ? res.accounts : [res.account]).find(want);
    if (hit) return hit;
  }
  return null;
}
const items = async (provider) =>
  (await api('GET', `/items?provider=${provider}&limit=100`)).json.items;
const findItem = (provider, re, accountIds) =>
  until(async () =>
    (await items(provider)).find(
      (i) =>
        re.test(`${i.title} ${i.summary}`) && (!accountIds || accountIds.includes(i.accountId)),
    ),
  );
const whenTriaged = (id) =>
  until(async () => {
    const all = (await api('GET', '/items?limit=100')).json.items;
    const it = all.find((i) => i.id === id);
    return it?.bucket ? it : null;
  });
const taskFor = (re) =>
  until(async () =>
    (await api('GET', '/tasks?status=open')).json.tasks.find((t) => re.test(t.title)),
  );
async function setUp(accounts) {
  for (const a of accounts) await api('PATCH', `/accounts/${a.id}`, { backfillDays: 7 });
  // Wait for the first sync so push subscriptions (channels, Graph, Jira webhooks) exist.
  await until(async () => {
    const { json } = await api('GET', '/accounts');
    return accounts.every((a) => json.accounts.find((x) => x.id === a.id)?.status === 'live');
  }, 45000);
  await sleep(1500);
}

token = (await api('POST', '/auth/dev', { email: `phase5-${RUN}@example.com`, name: 'Alex' })).json
  .token;
const catalog = (await api('GET', '/connectors')).json.connectors;
check(
  'catalog lists all six providers as available',
  catalog.length === 6 && catalog.every((c) => c.available),
  catalog.map((c) => c.provider).join(','),
);

// ---- Google Workspace ----
{
  const a = [(await connect('gmail')).account, (await connect('gmail')).account];
  const work = a.find((x) => x.externalId === 'alex@company.example');
  check('google: connected work account', !!work, a.map((x) => x.externalId).join(', '));
  await setUp([work]);
  fake('google', [
    '--kind',
    'chat',
    '--to',
    work.externalId,
    '--text',
    `Can you review the launch plan ${RUN}?`,
    '--mention',
  ]);
  const chat = await findItem('gmail', new RegExp(RUN), [work.id]);
  check('google chat message arrives on the work account', !!chat && chat.kind === 'chat');
  check(
    'google chat mention is a trusted signal',
    !!chat?.refs.includes('hub:mention'),
    chat?.refs.join(' '),
  );
  fake('google', [
    '--kind',
    'calendar',
    '--to',
    work.externalId,
    '--title',
    `Budget sync ${RUN}`,
    '--from',
    'Priya Raman <priya@company.example>',
  ]);
  const ev = await findItem('gmail', new RegExp(`Budget sync ${RUN}`), [work.id]);
  check(
    'google calendar invite arrives as an event with start time',
    !!ev && ev.kind === 'event' && ev.refs.some((r) => r.startsWith('gcal:start:')),
  );
  fake('google', [
    '--kind',
    'drive',
    '--to',
    work.externalId,
    '--title',
    `Launch plan ${RUN}`,
    '--from',
    'Sam Ortiz <sam@company.example>',
  ]);
  const file = await findItem('gmail', new RegExp(`Launch plan ${RUN}`), [work.id]);
  check('google drive share arrives as a file', !!file && file.kind === 'file');
}

// ---- Microsoft 365 ----
{
  // The work user (Teams needs a work tenant); the fake also has a personal MSA user.
  const ms = await connectUntil('microsoft', (a) => !a.isPersonal);
  check('microsoft: connected', !!ms, ms?.nickname);
  await setUp([ms]);
  const msUser = ['--user', 'avery.chen@contoso.example'];
  fake('microsoft', [
    ...msUser,
    '--kind',
    'mail',
    '--subject',
    `Slides ${RUN}`,
    '--body',
    'Could you send the slides by Thursday?',
  ]);
  const mail = await findItem('microsoft', new RegExp(`Slides ${RUN}`), [ms.id]);
  check('outlook mail arrives through a Graph notification', !!mail && mail.kind === 'email');
  fake('microsoft', [...msUser, '--kind', 'teams', '--body', `Can you join the call ${RUN}?`]);
  const teams = await findItem('microsoft', new RegExp(RUN), [ms.id].filter(Boolean));
  check('teams message arrives', !!teams && ['chat', 'email'].includes(teams.kind), teams?.kind);
}

// ---- Slack ----
{
  // The fake scripts post to the default fixture workspace / owner; pick that identity.
  const s = await connectUntil('slack', (a) => a.nickname === 'Acme Engineering');
  check('slack: connected a workspace', !!s, s?.nickname);
  await setUp([s]);
  fake('slack', [
    '--channel',
    'launch',
    '--from',
    'priya',
    '--text',
    `<@U0ALEX0001> is the launch doc ready ${RUN}?`,
  ]);
  const msg = await findItem('slack', new RegExp(RUN), [s.id]);
  check('slack message arrives through a signed event', !!msg && msg.kind === 'chat');
  check(
    'slack @-mention is a trusted signal',
    !!msg?.refs.includes('hub:mention'),
    msg?.refs.join(' '),
  );
  const triaged = msg && (await whenTriaged(msg.id));
  check(
    'slack mention is triaged as needs you',
    triaged?.bucket === 'needs_you',
    triaged?.statusLabel,
  );
  const draft = await until(async () =>
    (await api('GET', '/proposals?status=pending')).json.proposals.find(
      (p) => p.accountId === s.id,
    ),
  );
  check(
    'reply agent drafts a slack.post to the stored channel',
    draft?.action === 'slack.post' && typeof draft.payload.channel === 'string',
    draft?.title,
  );
}

// ---- Atlassian ----
{
  const res = await connect('atlassian');
  const sites = res.accounts ?? [];
  check(
    'atlassian: one consent adds two sites',
    sites.length === 2,
    sites.map((x) => x.nickname).join(', '),
  );
  await setUp(sites);
  const blocked = await findItem('atlassian', /PROJ-482/);
  check('jira backfill includes the blocked issue', !!blocked, blocked?.statusLabel);
  check(
    'jira blocking and assignment are trusted signals',
    !!blocked?.refs.includes('hub:assigned') &&
      blocked.refs.some((r) => r.startsWith('hub:blocking:')),
    blocked?.refs.join(' '),
  );
  const unblock = await taskFor(/PROJ-482/);
  check('an assigned, blocking issue becomes a task', !!unblock, unblock?.title);
  fake('atlassian', ['--create', '--summary', `Flaky login test ${RUN}`, '--site', 'acme']);
  const created = await findItem('atlassian', new RegExp(`Flaky login test ${RUN}`));
  check('new jira issue arrives through a signed webhook', !!created && created.kind === 'ticket');
}

// ---- Notion ----
{
  const n = await connectUntil('notion', (a) => a.nickname === 'Acme Product');
  check('notion: connected a workspace', !!n, n?.nickname);
  await setUp([n]);
  fake('notion', ['--title', `Standup ${RUN}`, '--text', ' ship the beta', '--todo', '--mention']);
  const page = await findItem('notion', new RegExp(`Standup ${RUN}`), [n.id]);
  check('notion page arrives through a signed webhook', !!page && page.kind === 'note');
  check(
    'notion mention is a trusted signal',
    !!page?.refs.includes('hub:mention'),
    page?.refs.join(' '),
  );
}

// ---- GitHub ----
{
  const g = await connectUntil('github', (a) => a.nickname === 'alexkim');
  check('github: connected', !!g, g?.nickname);
  await setUp([g]);
  fake('github', [
    '--action',
    'review',
    '--repo',
    'acme/web',
    '--title',
    `Tidy footer ${RUN}`,
    '--reviewer',
    'alexkim',
  ]);
  const pr = await findItem('github', new RegExp(`Tidy footer ${RUN}`), [g.id]);
  check('github review request arrives through a signed webhook', !!pr && pr.kind === 'ticket');
  check(
    'review request is a trusted signal',
    !!pr?.refs.includes('hub:review_requested'),
    pr?.refs.join(' '),
  );
  const review = await taskFor(new RegExp(`Review .*acme/web|Tidy footer ${RUN}|Review web`));
  check('a review request becomes a task', !!review, review?.title);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
