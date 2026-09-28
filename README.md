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

## Real mode

| What                                                         | Env                                                      | Phase |
| ------------------------------------------------------------ | -------------------------------------------------------- | ----- |
| Google OAuth client + Pub/Sub topic and push subscription    | `GOOGLE_*`, `GMAIL_PUBSUB_*`                             | 1     |
| Public URL for webhooks (tunnel in dev)                      | `PUBLIC_GATEWAY_URL`                                     | 1     |
| Anthropic API key                                            | `ANTHROPIC_API_KEY`                                      | 2     |
| Expo project for push                                        | `EXPO_ACCESS_TOKEN`                                      | 2     |
| AWS KMS keys for secrets at rest (read and write-token keys) | `SECRETS_PROVIDER=kms`, `KMS_KEY_ID`, `WRITE_KMS_KEY_ID` | prod  |

See `.env.example` for every variable and `apps/gateway/README.md` for the tunnel setup.
