# Hub

A personal context hub: a mobile app plus backend that reads email, chat, tickets and notes
across several accounts per service, turns them into one task list, and exposes that context
to Claude, Claude Code and other agents through a remote MCP server. You control everything
from the phone: permissions, models, approvals.

- Spec: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Build plan and progress: [docs/PLAN.md](docs/PLAN.md)
- Screen designs: [design/](design/README.md)
- Rules for working in this repo: [CLAUDE.md](CLAUDE.md)

## Quick start (offline demo mode)

Demo mode needs no Google project, API key or Expo account: Gmail is served from recorded
fixtures, models are a deterministic fake, and push notifications are logged.

```bash
pnpm i
cp .env.example .env
docker compose up -d        # Postgres :5434, Redis :6380
pnpm db:migrate
pnpm test
```

In `.env`, fill `SESSION_SECRET`, `LOCAL_MASTER_KEY` and `LOCAL_WRITE_MASTER_KEY` (the
comments say how to generate each), and turn on demo mode:
`GMAIL_FAKE=1`, `MODEL_PROVIDER=fake`, `PUSH_FAKE=1`, `DEV_AUTH=1`. `NODE_ENV` is required.

```bash
mkdir -p .dev && pnpm dev > .dev/dev.log 2>&1 &   # api :4000, gateway :4001, workers, mcp :4002
pnpm acceptance                                   # Phase 1-4 checks, end to end
pnpm --filter mobile start                        # Expo: w = web, i = iOS simulator
```

Sign in with any email under "Dev sign-in", connect Google twice (you get two fixture
mailboxes), then send yourself mail:

```bash
pnpm --filter @hub/gateway fake:email --to alex@company.example --from "Meera Iyer <meera@company.example>" --subject "Board pack" --body "Could you send me the board pack by Wednesday?"
```

Connect Claude Code with `claude mcp add --transport http hub http://localhost:4002/mcp`;
approve it on the phone with the code shown in the browser.

## Connectors

Google (Gmail, Calendar, Drive, Chat), Microsoft 365 (Outlook, Calendar, Teams, OneDrive),
Slack (per workspace), Atlassian (Jira, Confluence per site), Notion and GitHub. In demo
mode (`CONNECTORS_FAKE=1`) every provider serves recorded fixtures; `pnpm
acceptance:connectors` runs them all end to end, and `pnpm --filter @hub/connectors
fake:<provider>` delivers a change as a signed webhook.

## Real mode

| What                                                          | Env                                                      | Setup                    |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| Google OAuth client, Pub/Sub topics (Gmail, Workspace Events) | `GOOGLE_*`, `GMAIL_PUBSUB_*`, `GOOGLE_EVENTS_PUBSUB_*`   | `docs/CONNECTORS.md`     |
| Microsoft Entra app (+ optional write app)                    | `MS_*`                                                   | `docs/CONNECTORS.md`     |
| Slack app (+ optional write app)                              | `SLACK_*`                                                | `docs/CONNECTORS.md`     |
| Atlassian OAuth 2.0 (3LO) app                                 | `ATLASSIAN_*`                                            | `docs/CONNECTORS.md`     |
| Notion public integration                                     | `NOTION_*`                                               | `docs/CONNECTORS.md`     |
| GitHub App                                                    | `GITHUB_*`                                               | `docs/CONNECTORS.md`     |
| Public URL for webhooks (tunnel in dev)                       | `PUBLIC_GATEWAY_URL`                                     | `apps/gateway/README.md` |
| Anthropic API key (or Bedrock / Vertex per user)              | `ANTHROPIC_API_KEY`                                      |                          |
| Expo project for push                                         | `EXPO_ACCESS_TOKEN`                                      |                          |
| AWS KMS keys for secrets at rest (read and write-token keys)  | `SECRETS_PROVIDER=kms`, `KMS_KEY_ID`, `WRITE_KMS_KEY_ID` | `.env.example`           |

See `.env.example` for every variable.
