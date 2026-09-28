/**
 * Offline demo helper (CONNECTORS_FAKE=1 or ATLASSIAN_FAKE=1 only). Changes an issue in the
 * fake Atlassian store and POSTs the matching Jira webhook to the gateway, signed like
 * Atlassian signs deliveries to OAuth 2.0 apps (HS256 JWT with the client secret).
 *
 *   pnpm --filter @hub/connectors fake:atlassian --list
 *   pnpm --filter @hub/connectors fake:atlassian --issue PROJ-482 --comment "Any news?" --as Priya
 *   pnpm --filter @hub/connectors fake:atlassian --issue PROJ-477 --assign me
 *   pnpm --filter @hub/connectors fake:atlassian --issue PROJ-482 --status "In Review"
 *   pnpm --filter @hub/connectors fake:atlassian --create --summary "Flaky login test" --site acme
 *   pnpm --filter @hub/connectors fake:atlassian --touch-page 65601   (Confluence: polled, no push)
 *
 * Webhooks exist once the account is connected (the sync worker registers them).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FAKE_CLIENT_SECRET } from '../src/atlassian/config';
import { FAKE_STATUSES, allocId } from '../src/atlassian/fake';
import {
  DEFAULT_FAKE_STORE_PATH,
  defaultFakeStore,
  jiraTimestamp,
  type FakeAtlassianState,
  type FakeIssue,
  type FakeSite,
} from '../src/atlassian/fake-store';
import { textToAdf } from '../src/atlassian/text';
import { signJwt } from '../src/atlassian/webhooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const on = (v: string | undefined) => v === '1' || v === 'true';
if (
  !(on(process.env.CONNECTORS_FAKE) || on(process.env.ATLASSIAN_FAKE)) ||
  process.env.NODE_ENV === 'production'
) {
  console.error('fake:atlassian needs CONNECTORS_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    site: { type: 'string' },
    issue: { type: 'string', default: 'PROJ-482' },
    status: { type: 'string' },
    assign: { type: 'string' },
    comment: { type: 'string' },
    as: { type: 'string', default: 'Priya' },
    create: { type: 'boolean', default: false },
    summary: { type: 'string', default: 'New issue from fake:atlassian' },
    'touch-page': { type: 'string' },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const store = defaultFakeStore();

function personId(s: FakeAtlassianState, who: string): string | null {
  if (who === 'none') return null;
  if (who === 'me') return s.user.account_id;
  if (s.people[who]) return who;
  const hit = Object.entries(s.people).find(([, p]) =>
    p.displayName.toLowerCase().startsWith(who.toLowerCase()),
  );
  if (!hit)
    throw new Error(
      `unknown person ${who}; known: ${Object.values(s.people)
        .map((p) => p.displayName)
        .join(', ')}`,
    );
  return hit[0];
}

if (values.list) {
  const s = store.read();
  for (const site of s.sites) {
    console.log(
      `${site.name}  ${site.url}  cloudId ${site.cloudId}  (${site.products.join(', ')})`,
    );
    for (const i of site.issues) {
      const a = i.fields.assignee
        ? (s.people[i.fields.assignee]?.displayName ?? '?')
        : 'unassigned';
      console.log(`  ${i.key.padEnd(10)} ${i.fields.status.name.padEnd(12)} ${a}`);
    }
    for (const p of site.pages) console.log(`  page ${p.id}  v${p.version.number}`);
    console.log(
      `  webhooks: ${(site.webhooks ?? []).map((w) => `${w.id} [${w.jqlFilter}]`).join(', ') || 'none'}`,
    );
  }
  console.log(`store: ${DEFAULT_FAKE_STORE_PATH()}`);
  process.exit(0);
}

if (values['touch-page']) {
  const id = values['touch-page'];
  const ok = store.update((s) => {
    for (const site of s.sites) {
      const p = site.pages.find((x) => x.id === id);
      if (p) {
        p.version = {
          ...p.version,
          number: p.version.number + 1,
          when: new Date().toISOString(),
          by: personId(s, values.as!)!,
        };
        return true;
      }
    }
    return false;
  });
  console.log(
    ok
      ? `page ${id} edited; Confluence is polled, it appears on the next catch-up sync`
      : `no page ${id}`,
  );
  process.exit(ok ? 0 : 1);
}

type Change = { site: FakeSite; issue: FakeIssue; event: string; commentId?: string };

const change: Change = store.update((s) => {
  const now = Date.now();
  const t = jiraTimestamp(now);
  if (values.create) {
    const site = values.site ? s.sites.find((x) => x.name === values.site) : s.sites[0];
    if (!site) throw new Error(`no site ${values.site}`);
    const project = site.issues[0]?.fields.project ?? { key: 'PROJ', name: 'Project' };
    const n =
      Math.max(
        0,
        ...site.issues
          .filter((i) => i.fields.project.key === project.key)
          .map((i) => Number(i.key.split('-')[1])),
      ) + 1;
    const issue: FakeIssue = {
      id: allocId(s),
      key: `${project.key}-${n}`,
      watchers: [],
      properties: {},
      fields: {
        summary: values.summary!,
        status: { id: '1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
        priority: { id: '3', name: 'Medium' },
        assignee: personId(s, values.assign ?? 'me'),
        reporter: personId(s, values.as!),
        issuetype: { name: 'Task' },
        project,
        created: t,
        updated: t,
        description: textToAdf(values.comment ?? 'Created by fake:atlassian.'),
        issuelinks: [],
        comment: { comments: [] },
      },
    };
    site.issues.push(issue);
    return { site, issue, event: 'jira:issue_created' };
  }

  const site = s.sites.find((x) => x.issues.some((i) => i.key === values.issue));
  const issue = site?.issues.find((i) => i.key === values.issue);
  if (!site || !issue) throw new Error(`no issue ${values.issue}`);
  let event = 'jira:issue_updated';
  let commentId: string | undefined;
  if (values.status) {
    const to = FAKE_STATUSES.find((x) => x.name.toLowerCase() === values.status!.toLowerCase());
    if (!to)
      throw new Error(`unknown status; use one of ${FAKE_STATUSES.map((x) => x.name).join(', ')}`);
    issue.fields.status = {
      id: to.id,
      name: to.name,
      statusCategory: { key: to.category, name: to.name },
    };
  }
  if (values.assign) issue.fields.assignee = personId(s, values.assign);
  if (values.comment) {
    commentId = allocId(s);
    issue.fields.comment.comments.push({
      id: commentId,
      author: personId(s, values.as!)!,
      created: t,
      updated: t,
      body: textToAdf(values.comment),
    });
    if (!values.status && !values.assign) event = 'comment_created';
  }
  if (!values.status && !values.assign && !values.comment)
    throw new Error('nothing to change: pass --status, --assign or --comment');
  issue.fields.updated = t;
  return { site, issue, event, ...(commentId ? { commentId } : {}) };
});
console.log(`${change.event} ${change.issue.key} on ${change.site.name}`);

if (values['no-push']) process.exit(0);

// Deliveries go to every webhook URL whose JQL filter matches, once per URL.
const matches = (filter: string, i: FakeIssue) => {
  const m = /^(assignee|reporter) = "([^"]+)"$/.exec(filter);
  return !!m && i.fields[m[1] as 'assignee' | 'reporter'] === m[2];
};
const byUrl = new Map<string, number[]>();
for (const w of change.site.webhooks ?? []) {
  if (!matches(w.jqlFilter, change.issue)) continue;
  byUrl.set(w.url, [...(byUrl.get(w.url) ?? []), w.id]);
}
if (!byUrl.size) {
  console.log(
    'no registered webhook matches (not connected yet, or a watcher/mention change): it syncs on the next catch-up.',
  );
  process.exit(0);
}

const secret = process.env.ATLASSIAN_CLIENT_SECRET || FAKE_CLIENT_SECRET;
for (const [hookUrl, ids] of byUrl) {
  const target = new URL(hookUrl);
  if (values.gateway) {
    const g = new URL(values.gateway);
    target.protocol = g.protocol;
    target.host = g.host;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const body = {
    timestamp: Date.now(),
    webhookEvent: change.event,
    matchedWebhookIds: ids,
    issue: {
      id: change.issue.id,
      key: change.issue.key,
      self: `https://api.atlassian.com/ex/jira/${change.site.cloudId}/rest/api/2/issue/${change.issue.id}`,
    },
    ...(change.commentId ? { comment: { id: change.commentId } } : {}),
  };
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${signJwt({ iat: nowSec, exp: nowSec + 300 }, secret)}`,
      'x-atlassian-webhook-identifier': randomUUID(),
    },
    body: JSON.stringify(body),
  }).catch((e: unknown) => {
    console.error(`push failed: ${(e as Error).message}`);
    return null;
  });
  if (res) console.log(`pushed to ${target.origin}${target.pathname} → ${res.status}`);
}
