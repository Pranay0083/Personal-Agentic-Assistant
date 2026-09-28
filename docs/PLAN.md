# Build plan

Work one phase at a time. Tick boxes as you go. Each phase ends with its acceptance checks passing.

## Phase 0 — Scaffold

- [ ] pnpm monorepo with the layout in CLAUDE.md, strict TS config, ESLint, Prettier, Vitest
- [ ] `docker compose` with Postgres 16 (+pgvector) and Redis
- [ ] `packages/db`: Drizzle schema for every table in ARCHITECTURE.md, first migration
- [ ] `packages/shared`: zod schemas for Account, Item, Task, Proposal, Policy
- [ ] `.env.example` with every variable, documented
- [ ] Secrets helper: envelope encryption with a local dev key and a KMS implementation behind one interface
- [ ] CI workflow running lint, typecheck, test

**Accept:** `pnpm i && docker compose up -d && pnpm db:migrate && pnpm test` passes on a clean clone.

## Phase 1 — Gmail, multiple accounts, read-only feed

- [ ] Google OAuth (`gmail.readonly`, offline access) in `apps/api`; one user can connect several Google accounts; each becomes an `accounts` row with nickname and color
- [ ] `packages/connectors/gmail`: `connect`, `subscribe` (users.watch), `renew`, `verifyWebhook` (Pub/Sub OIDC), `fetchDelta` (history.list), `normalize`
- [ ] `apps/gateway`: `/hooks/gmail` with dedupe on `provider_event_id`
- [ ] Sync worker + scheduler (daily watch renewal, catch-up sync every 15 min)
- [ ] Backfill job honoring the chosen window (7/30/90 days)
- [ ] API: `GET /items` with account filter
- [ ] Mobile: Expo app with sign-in, Connect and Scope onboarding screens, Inbox screen with the account switcher
- [ ] Tests with recorded Gmail fixtures

**Accept:** connect two Gmail accounts, send a test email to each, both appear in the Inbox within a minute, tagged with the right account.

## Phase 2 — Agents and push

- [ ] `packages/models`: router, Anthropic adapter, `fenceUntrusted`, usage logging
- [ ] Triage and extractor agents; tasks link to `source_item_id`
- [ ] Daily brief agent (scheduled per user timezone)
- [ ] Notifier with expo-notifications, quiet hours, VIP list
- [ ] Mobile: Today and Tasks screens, First win onboarding screen (confirm or reject tasks feeds back into triage)

**Accept:** an email asking for something by a date produces a task with that due date and a push notification; the brief lists it the next morning.

## Phase 3 — Policy engine and MCP

- [ ] `packages/policy` with presets, per-account overrides, temporary grants; exhaustive unit tests
- [ ] Wire `can()` into agents and API
- [ ] `apps/mcp`: Streamable HTTP, OAuth for clients, per-client scoped tokens, tools from ARCHITECTURE.md
- [ ] Permission requests from MCP clients appear in Approvals; "Allow 1 hour" creates a grant
- [ ] Mobile: Permissions screen, Presets onboarding, Connect agents onboarding, Control screen

**Accept:** Claude Code connected via `claude mcp add` can search Jira-scoped context but gets denied on personal Gmail, and a request for temporary access shows up on the phone.

## Phase 4 — Proposals and executor

- [ ] Reply agent writes proposals; `propose_action` MCP tool writes proposals
- [ ] Executor with idempotency keys, policy re-check, Gmail send (separate write-scope consent)
- [ ] Approvals screen with approve, edit, reject; kill switch pauses all agents
- [ ] Activity log screen from `audit_log`

**Accept:** approving a draft sends exactly one email even if the job is retried; rejecting changes nothing; pause stops all agent jobs.

## Phase 5 — More connectors and providers

- [ ] Microsoft 365 (Outlook, Teams, OneDrive) with Graph subscriptions and delta queries
- [ ] Slack (per workspace), Atlassian (per site), Notion, GitHub
- [ ] Model adapters: OpenAI, Bedrock, Vertex, OpenAI-compatible (Groq, OpenRouter, Azure, custom gateway)
- [ ] Per-agent model picker and provider setup screens; fallback toggle; monthly cap
- [ ] Connectors screen with per-account status and reconnect

**Accept:** each connector passes its fixture tests and a live smoke test; switching triage to Groq and planning to Bedrock works, and killing a provider falls back cleanly.

## Phase 6 — Later

- [ ] Mac helper app (Obsidian vault, Apple Notes, Reminders, iMessage) pushing to the API
- [ ] Local models via Ollama
- [ ] Data export and "delete everything" flow end to end
