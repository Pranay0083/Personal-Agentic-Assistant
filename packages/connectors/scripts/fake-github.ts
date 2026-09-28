/**
 * Offline demo helper (CONNECTORS_FAKE=1 only): opens an issue, requests a review or
 * comments in the fake GitHub store and POSTs a signed App webhook to the gateway.
 *
 *   pnpm --filter @hub/connectors fake:github --action open --repo acme/api --title "Flaky test" --assignee alexkim
 *   pnpm --filter @hub/connectors fake:github --action review --repo acme/web --title "Tidy footer" --reviewer alexkim
 *   pnpm --filter @hub/connectors fake:github --action comment --repo acme/web --number 42 --body "@alexkim ping"
 *   pnpm --filter @hub/connectors fake:github --list
 *
 * Signed with GITHUB_WEBHOOK_SECRET, or `fake-github-secret`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultFakePath, fakeMode } from '../src/lib/fake';
import {
  fakeGithubAction,
  fakeGithubStore,
  githubConfigFromEnv,
  githubSignature,
  githubWebhookSecret,
} from '../src/github/index';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!fakeMode()) {
  console.error('fake:github needs CONNECTORS_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    action: { type: 'string', default: 'open' },
    repo: { type: 'string', default: 'acme/web' },
    number: { type: 'string' },
    title: { type: 'string', default: 'Checkout button does nothing on Android' },
    body: { type: 'string', default: '@alexkim can you take a look before the release?' },
    by: { type: 'string', default: 'priyar' },
    assignee: { type: 'string' },
    reviewer: { type: 'string', default: 'alexkim' },
    pr: { type: 'boolean', default: false },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const store = fakeGithubStore();
if (values.list) {
  const s = store.read();
  for (const i of s.installations) {
    console.log(`installation ${i.id} (${i.account.login}) users ${i.users.join(', ')}`);
    for (const repo of i.repos) {
      for (const x of s.issues.filter((y) => y.repo === repo)) {
        console.log(`  ${repo}#${x.number} [${x.type}] ${x.title} (updated ${x.updatedAt})`);
      }
    }
  }
  console.log(`store: ${defaultFakePath('github')}`);
  process.exit(0);
}

const repo = values.repo!;
const number = values.number ? Number(values.number) : undefined;
let result;
let event: string;
let action: string;
try {
  if (values.action === 'open') {
    result = fakeGithubAction(store, {
      kind: 'open',
      repo,
      title: values.title!,
      body: values.body!,
      by: values.by!,
      pr: values.pr!,
      ...(values.assignee ? { assignee: values.assignee } : {}),
    });
    event = result.issue.type === 'pr' ? 'pull_request' : 'issues';
    action = 'opened';
  } else if (values.action === 'review') {
    result = fakeGithubAction(store, {
      kind: 'review',
      repo,
      by: values.by!,
      reviewer: values.reviewer!,
      ...(number !== undefined ? { number } : { title: values.title! }),
    });
    event = 'pull_request';
    action = 'review_requested';
  } else if (values.action === 'comment') {
    if (number === undefined) throw new Error('--number is required for --action comment');
    result = fakeGithubAction(store, {
      kind: 'comment',
      repo,
      number,
      body: values.body!,
      by: values.by!,
    });
    event = 'issue_comment';
    action = 'created';
  } else {
    throw new Error('--action must be open, review or comment');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const { issue, installationId } = result;
console.log(`${action} ${repo}#${issue.number} [${issue.type}] (installation ${installationId})`);

if (!values['no-push']) {
  const secret = githubWebhookSecret(githubConfigFromEnv())!;
  const s = store.read();
  const sender = s.users.find((u) => u.login === values.by) ?? { login: values.by!, id: 0 };
  const ref = { number: issue.number, title: issue.title, user: { login: issue.author } };
  const payload = {
    action,
    ...(event === 'pull_request' ? { number: issue.number, pull_request: ref } : { issue: ref }),
    ...(action === 'review_requested' ? { requested_reviewer: { login: values.reviewer } } : {}),
    repository: { full_name: repo, private: true },
    sender: { login: sender.login, id: sender.id },
    installation: { id: installationId },
  };
  const rawBody = JSON.stringify(payload);
  const gateway = values.gateway ?? process.env.PUBLIC_GATEWAY_URL ?? 'http://localhost:4001';
  const url = `${gateway.replace(/\/$/, '')}/hooks/github`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': githubSignature(secret, rawBody),
      },
      body: rawBody,
    });
    console.log(`webhook ${event}.${action} → ${url}: HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`webhook → ${url} failed: is the gateway running (pnpm dev)?`);
    process.exitCode = 1;
  }
}
