# Hub — personal context hub

A mobile app plus backend that reads a person's email, chat, tickets and notes across
**multiple accounts per service**, turns them into one task list, and exposes that
context to Claude, Claude Code and other agents through a remote MCP server. The user
controls everything from the phone: permissions, models, approvals.

Full spec: `docs/ARCHITECTURE.md`. Build order: `docs/PLAN.md`. Screen designs:
`design/screens/` (see `design/README.md`).

## Non-negotiable rules

These protect the user's data. Never relax them to make something work faster.

1. **Read-only by default.** Connectors request read scopes only. Write scopes live
   only in the action executor.
2. **Agents never act.** Agent workers output data (tasks, labels, summaries) or
   `proposals`. Only `apps/workers/executor` performs writes, and only for proposals
   with status `approved`.
3. **Every access goes through `packages/policy`.** Call
   `can(principal, accountId, resource, action)` before any read or write, in agents,
   the MCP server and the executor. The executor re-checks at execution time.
4. **Content from email, chat, tickets and notes is untrusted.** When passing it to a
   model, wrap it with `fenceUntrusted()` from `packages/models`. Never let it choose
   tools, recipients or URLs.
5. **Secrets are encrypted at rest** (envelope encryption, KMS master key). Store
   `token_ref` / `secret_ref`, never raw tokens. Never log tokens, keys, email bodies
   or message text. Never send secrets to the mobile app.
6. **Everything is keyed by `account_id`.** A user can have several Gmail accounts,
   Slack workspaces, Jira sites. Never assume one account per provider.
7. **Idempotency.** Webhook events dedupe on `provider_event_id`. Executor actions
   carry an `idempotency_key`. Retries must never double-send.
8. **Audit everything.** Every agent read, proposal, approval and execution writes to
   the append-only `audit_log`.

## Stack

- TypeScript (strict) everywhere, pnpm workspaces, Node 22 LTS.
- Mobile: React Native with Expo (expo-router), push via expo-notifications.
- API and gateway: Fastify. Validation: zod. Shared types in `packages/shared`.
- Database: Postgres 16 + pgvector. ORM and migrations: Drizzle.
- Queue: Redis + BullMQ. Scheduler: BullMQ repeatable jobs.
- MCP: official TypeScript MCP SDK, Streamable HTTP transport, OAuth for clients.
- Tests: Vitest. Lint and format: ESLint + Prettier.
- Local dev: `docker compose` for Postgres and Redis.

## Repo layout

```
apps/
  mobile/      Expo app (screens from design/screens)
  api/         REST + SSE for the app
  gateway/     webhook receivers, /hooks/:provider
  workers/     sync, agents, executor, notifier, scheduler (one process per queue)
  mcp/         remote MCP server
packages/
  connectors/  one folder per provider, same interface
  policy/      permission engine
  models/      model router + provider adapters + fenceUntrusted
  db/          Drizzle schema and migrations
  shared/      types and zod schemas shared by app and backend (incl. the REST contract in api.ts)
  server/      backend-only runtime: env, redacting logger, envelope encryption, queues, live events
```

Never import `@hub/server`, `@hub/db` or `@hub/policy` from `apps/mobile`; it may only use
`@hub/shared` (and `@hub/shared/api`).

## Connector interface

Every provider folder in `packages/connectors/<provider>` exports:
`connect` (OAuth), `subscribe`, `renew`, `verifyWebhook`, `fetchDelta`, `normalize`,
and optionally `execute` (write actions, used only by the executor).

## Commands

- `pnpm i` — install
- `docker compose up -d` — Postgres (localhost:5434) + Redis (localhost:6380)
- `pnpm db:migrate` — run migrations (`pnpm db:generate` after editing the schema)
- `pnpm dev` — run api, gateway, workers, mcp
- `pnpm --filter mobile start` — Expo
- `pnpm test` / `pnpm lint` / `pnpm typecheck`
- `pnpm acceptance` — end-to-end Phase 1–4 checks against a running `pnpm dev` in demo mode
- `pnpm --filter @hub/gateway fake:email --to <addr> --from "Name <addr>" --subject … --body …`
  — deliver a test email in demo mode (`GMAIL_FAKE=1`)

Keep these commands working. Update this section if you change them.

## How to work in this repo

- Work one phase of `docs/PLAN.md` at a time. Finish its acceptance checks before
  moving on, then tick the boxes in PLAN.md.
- Write tests for connectors (with recorded fixtures, never real accounts), the
  policy engine and the executor. These are the risky parts.
- Keep `.env.example` complete. Never commit real secrets.
- For webhooks in local dev, use a tunnel (cloudflared or ngrok) and document it.
- Ask before adding a new external service or a heavy dependency.
