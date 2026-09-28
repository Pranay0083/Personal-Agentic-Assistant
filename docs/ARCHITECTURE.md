# Architecture

## Services

| Service                    | Job                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                 | Serves the mobile app: auth, settings, feeds, approvals, permissions. SSE for live updates.                                                                           |
| `apps/gateway`             | Receives webhooks at `/hooks/:provider`. Verifies, maps to `account_id`, dedupes, writes an `events` row, enqueues `sync`, returns 200 fast. No real work.            |
| `apps/workers` — sync      | Pulls the actual delta for the account, normalizes into `items`, enqueues `triage`.                                                                                   |
| `apps/workers` — scheduler | Renews expiring subscriptions and watches; runs a catch-up sync per account on a timer.                                                                               |
| `apps/workers` — agents    | Triage, extractor, brief, reply. Output tasks, labels, summaries or `proposals`. No write credentials.                                                                |
| `apps/workers` — executor  | Only holder of write scopes. Executes `approved` proposals after re-checking policy. Idempotent.                                                                      |
| `apps/workers` — notifier  | Push notifications (approvals, VIPs), honoring quiet hours.                                                                                                           |
| `apps/mcp`                 | Remote MCP server (Streamable HTTP + OAuth). Scoped tokens per client. Tools: `search_context`, `get_my_tasks`, `get_thread`, `get_project_status`, `propose_action`. |
| `packages/policy`          | `can(principal, accountId, resource, action)` used by everything above.                                                                                               |

## Webhook verification per provider

- **Gmail:** `users.watch` to a shared Pub/Sub topic; push subscription with OIDC auth.
  Verify the OIDC token. Payload has `emailAddress` + `historyId`; map email to
  account; `history.list` from the stored cursor. Watches expire in 7 days: renew daily.
- **Microsoft Graph (Outlook, Teams, OneDrive):** answer the `validationToken` on
  subscription creation; compare `clientState` on every notification; handle
  lifecycle notifications (reauthorization). Use delta queries. Renew before expiry.
- **Slack:** verify `X-Slack-Signature` (HMAC, with timestamp freshness); answer the
  `url_verification` challenge.
- **Atlassian (Jira, Confluence):** register dynamic webhooks through the OAuth app;
  verify per Atlassian's signing scheme; refresh registrations before they expire (~30 days).
- **Notion, GitHub:** verify their signature headers.
- **No webhook sources** (Obsidian, Apple Notes, iMessage): future Mac helper app that
  pushes changes to the API. Out of scope until Phase 6.

## Event flow (one email)

1. Email arrives in the user's "Work" Gmail → Pub/Sub → `gateway`.
2. Gateway verifies, maps `emailAddress` to `account_id`, inserts `events`
   (unique `provider_event_id`), enqueues `sync`.
3. Sync fetches via that account's token, upserts `items`, enqueues `triage`.
4. Triage (per-agent model) decides if it needs the user; extractor creates `tasks`;
   reply agent writes a `proposal`.
5. Notifier pushes "Draft ready".
6. User approves in the app → API sets proposal `approved` → executor re-checks
   policy, sends, marks `executed`. Every step writes `audit_log`.

## Data model

```sql
users         (id, email, created_at)
accounts      (id, user_id, provider, nickname, color, external_id, status,
               token_ref, filters jsonb, sync_cursor, created_at)
subscriptions (id, account_id, kind, external_sub_id, expires_at)
events        (id, account_id, provider_event_id UNIQUE, payload jsonb, status, created_at)

items         (id, account_id, kind, external_id, thread_id, author, title,
               body_ref, summary, received_at, embedding vector(1024))
people        (id, user_id, name, emails text[], handles jsonb)
tasks         (id, user_id, title, due_at, status, project, source_item_id,
               confidence, confirmed_by_user)

proposals     (id, user_id, account_id, agent, action, payload jsonb, status,
               decided_at, executed_at, idempotency_key UNIQUE)
policies      (id, user_id, principal, account_id NULL, resource, level)
grants        (id, user_id, principal, account_id, scope, expires_at)

agent_configs (id, user_id, agent, provider_id, model, fallback bool)
providers     (id, user_id, kind, config jsonb, secret_ref)
mcp_clients   (id, user_id, name, token_hash, scopes jsonb)
audit_log     (id, user_id, principal, action, target, at)  -- append only
```

Notes: `body_ref` points to separately stored bodies with their own retention.
`policies.account_id` NULL means "all accounts of this provider"; a specific
account row overrides it. Levels: `none | read | draft | ask | auto | never`.

## Policy engine

```ts
type Principal = { kind: 'user' } | { kind: 'agent'; name: string } | { kind: 'mcp'; clientId: string };
can(p: Principal, accountId: string, resource: string, action: 'read' | 'draft' | 'write'): Promise<Decision>
// Decision = { allow: boolean; needsApproval: boolean; reason: string }
```

Resolution order: active `grants` → account-specific `policies` → provider-wide
`policies` → preset defaults (Cautious / Balanced / Hands-off) → deny.
"Stricter for personal accounts" is stored as account-specific policies.

## Model router

```ts
interface ModelProvider {
  generate(req: {
    model: string;
    system: string;
    messages: Message[];
    tools?: Tool[];
  }): Promise<Result>;
}
```

Adapters: Anthropic, OpenAI (native SDKs); AWS Bedrock, Google Vertex AI (cloud SDKs);
one OpenAI-compatible adapter covering Groq, OpenRouter, Azure OpenAI and custom
gateways (OmniRoute, LiteLLM, Portkey) via base URL. Local: Ollama (later).
The router resolves `agent_configs`, applies timeouts and retries, falls back to the
recommended model when `fallback` is on, enforces a per-user monthly cap, and logs
tokens and cost per agent.

Recommended defaults: triage → Claude Haiku 4.5; brief and replies → Claude Sonnet 5;
planning → Claude Opus 5.5.

## Security checklist

- Envelope encryption for tokens and provider keys; decrypt only in the worker using them.
- `fenceUntrusted(content)` wraps any user content sent to a model in nonce-delimited
  markers with an instruction to treat it as data.
- Executor shows exact payload in the app and re-checks policy at execution time.
- Per-provider, per-account rate limiting with backoff on 429.
- "Delete everything" job: revoke OAuth tokens at each provider, delete rows and
  bodies, confirm to the app.
- Dead-letter queue for failed jobs; alert on repeated failures per account.
