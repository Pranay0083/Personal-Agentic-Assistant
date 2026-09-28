# Build plan

Work one phase at a time. Tick boxes as you go. Each phase ends with its acceptance checks passing.

## Phase 0 — Scaffold

- [x] pnpm monorepo with the layout in CLAUDE.md, strict TS config, ESLint, Prettier, Vitest
- [x] `docker compose` with Postgres 16 (+pgvector) and Redis
- [x] `packages/db`: Drizzle schema for every table in ARCHITECTURE.md, first migration
- [x] `packages/shared`: zod schemas for Account, Item, Task, Proposal, Policy
- [x] `.env.example` with every variable, documented
- [x] Secrets helper: envelope encryption with a local dev key and a KMS implementation behind one interface
- [x] CI workflow running lint, typecheck, test

**Accept:** `pnpm i && docker compose up -d && pnpm db:migrate && pnpm test` passes on a clean clone.

> ✅ Verified on a fresh `git clone` (see git log).

## Phase 1 — Gmail, multiple accounts, read-only feed

- [x] Google OAuth (`gmail.readonly`, offline access) in `apps/api`; one user can connect several Google accounts; each becomes an `accounts` row with nickname and color
- [x] `packages/connectors/gmail`: `connect`, `subscribe` (users.watch), `renew`, `verifyWebhook` (Pub/Sub OIDC), `fetchDelta` (history.list), `normalize`
- [x] `apps/gateway`: `/hooks/gmail` with dedupe on `provider_event_id`
- [x] Sync worker + scheduler (daily watch renewal, catch-up sync every 15 min)
- [x] Backfill job honoring the chosen window (7/30/90 days)
- [x] API: `GET /items` with account filter
- [x] Mobile: Expo app with sign-in, Connect and Scope onboarding screens, Inbox screen with the account switcher
- [x] Tests with recorded Gmail fixtures

**Accept:** connect two Gmail accounts, send a test email to each, both appear in the Inbox within a minute, tagged with the right account.

> ✅ Verified in demo mode (`GMAIL_FAKE=1`, fixture mailboxes, real gateway/sync/worker processes) by `pnpm acceptance`: both arrive in ~1s on the right account.
> ⏳ Still to do with a real Google project: OAuth client, Pub/Sub topic + push subscription, tunnel (`apps/gateway/README.md`).

## Phase 2 — Agents and push

- [x] `packages/models`: router, Anthropic adapter, `fenceUntrusted`, usage logging
- [x] Triage and extractor agents; tasks link to `source_item_id`
- [x] Daily brief agent (scheduled per user timezone)
- [x] Notifier with expo-notifications, quiet hours, VIP list
- [x] Mobile: Today and Tasks screens, First win onboarding screen (confirm or reject tasks feeds back into triage)

**Accept:** an email asking for something by a date produces a task with that due date and a push notification; the brief lists it the next morning.

> ✅ Verified in demo mode with the deterministic fake model and logged pushes: "could you send me the board pack by Wednesday?" → task due Wed 17:00 (user's timezone), generic push, brief lists it.
> ⏳ Still to do: real run with `ANTHROPIC_API_KEY` and an Expo push token on a device.

## Phase 3 — Policy engine and MCP

- [x] `packages/policy` with presets, per-account overrides, temporary grants; exhaustive unit tests
- [x] Wire `can()` into agents and API
- [x] `apps/mcp`: Streamable HTTP, OAuth for clients, per-client scoped tokens, tools from ARCHITECTURE.md
- [x] Permission requests from MCP clients appear in Approvals; "Allow 1 hour" creates a grant
- [x] Mobile: Permissions screen, Presets onboarding, Connect agents onboarding, Control screen

**Accept:** Claude Code connected via `claude mcp add` can search Jira-scoped context but gets denied on personal Gmail, and a request for temporary access shows up on the phone.

> ✅ Verified with a scripted MCP client doing the same OAuth flow Claude Code uses (DCR + PKCE + phone approval with pairing code): work context readable and fenced, personal Gmail withheld, `request_access` shows on the phone, "Allow 1 hour" opens it. Jira itself is covered by `apps/mcp` tests (no Atlassian connector until Phase 5).
> ⏳ Still to do: `claude mcp add --transport http hub http://localhost:4002/mcp` from a real Claude Code.

## Phase 4 — Proposals and executor

- [x] Reply agent writes proposals; `propose_action` MCP tool writes proposals
- [x] Executor with idempotency keys, policy re-check, Gmail send (separate write-scope consent)
- [x] Approvals screen with approve, edit, reject; kill switch pauses all agents
- [x] Activity log screen from `audit_log`

**Accept:** approving a draft sends exactly one email even if the job is retried; rejecting changes nothing; pause stops all agent jobs.

> ✅ Verified by `pnpm acceptance` and executor tests: one send under double approve, concurrent jobs and a simulated crash between send and bookkeeping; reject sends nothing; paused users get no agent output (events still sync) and resume re-triages what arrived.

## Phase 5 — More connectors and providers

- [ ] Microsoft 365 (Outlook, Teams, OneDrive) with Graph subscriptions and delta queries
- [ ] Slack (per workspace), Atlassian (per site), Notion, GitHub
- [ ] Model adapters: OpenAI, Bedrock, Vertex, OpenAI-compatible (Groq, OpenRouter, Azure, custom gateway) — _OpenAI and OpenAI-compatible done; Bedrock/Vertex are stubs_
- [x] Per-agent model picker and provider setup screens; fallback toggle; monthly cap
- [x] Connectors screen with per-account status and reconnect (Gmail only so far)

**Accept:** each connector passes its fixture tests and a live smoke test; switching triage to Groq and planning to Bedrock works, and killing a provider falls back cleanly.
