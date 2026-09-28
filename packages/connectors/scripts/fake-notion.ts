/**
 * Offline demo helper (CONNECTORS_FAKE=1 only): edits or creates a page in the fake Notion
 * store and POSTs a signed integration webhook to the gateway, like Notion would.
 *
 *   pnpm --filter @hub/connectors fake:notion --title "Standup" --text " ship the beta" --todo --mention
 *   pnpm --filter @hub/connectors fake:notion --page <page id> --text "One more thing"
 *   pnpm --filter @hub/connectors fake:notion --list
 *
 * The webhook is signed with NOTION_WEBHOOK_VERIFICATION_TOKEN, or `fake-notion-token`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultFakePath, fakeMode } from '../src/lib/fake';
import {
  editFakePage,
  fakeNotionStore,
  notionConfigFromEnv,
  notionSignature,
  notionWebhookKey,
} from '../src/notion/index';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!fakeMode()) {
  console.error('fake:notion needs CONNECTORS_FAKE=1 (and never runs in production).');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    page: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string', default: 'Alex, can you review the pricing section by Friday?' },
    todo: { type: 'boolean', default: false },
    mention: { type: 'boolean', default: false },
    by: { type: 'string' },
    gateway: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const store = fakeNotionStore();
if (values.list) {
  const s = store.read();
  for (const ws of s.workspaces) {
    console.log(`${ws.id}  ${ws.name} (owner ${ws.owner.name})`);
    for (const p of s.pages.filter((x) => x.workspaceId === ws.id)) {
      console.log(`  ${p.id}  ${p.title}  edited ${p.lastEditedTime}`);
    }
  }
  console.log(`store: ${defaultFakePath('notion')}`);
  process.exit(0);
}

const { page, created, workspace } = editFakePage(store, {
  text: values.text!,
  todo: values.todo!,
  mention: values.mention!,
  ...(values.workspace ? { workspaceId: values.workspace } : {}),
  ...(values.page ? { pageId: values.page } : {}),
  ...(values.title ? { title: values.title } : {}),
  ...(values.by ? { by: values.by } : {}),
});
console.log(`${created ? 'created' : 'edited'} page ${page.id} in ${workspace.name}`);

if (!values['no-push']) {
  const key = notionWebhookKey(notionConfigFromEnv())!;
  const event = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    subscription_id: 'fake-subscription',
    integration_id: 'fake-integration',
    type: created ? 'page.created' : 'page.content_updated',
    authors: [{ id: page.lastEditedBy, type: 'person' }],
    attempt_number: 1,
    entity: { id: page.id, type: 'page' },
    data: { parent: { id: workspace.id, type: 'space' } },
  };
  const rawBody = JSON.stringify(event);
  const gateway = values.gateway ?? process.env.PUBLIC_GATEWAY_URL ?? 'http://localhost:4001';
  const url = `${gateway.replace(/\/$/, '')}/hooks/notion`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-notion-signature': notionSignature(key, rawBody),
      },
      body: rawBody,
    });
    console.log(`webhook ${event.type} → ${url}: HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`webhook → ${url} failed: is the gateway running (pnpm dev)?`);
    process.exitCode = 1;
  }
}
