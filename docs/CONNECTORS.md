# Connectors

What each connector reads, how it gets changes, and how to set up the provider app for real
(non-demo) use. For local demos, set `CONNECTORS_FAKE=1` and use the `fake:<provider>`
scripts instead (see `CLAUDE.md` → Commands).

Everywhere:

- **OAuth callbacks** are `<PUBLIC_API_URL>/oauth/<provider>/callback` (Google uses
  `/oauth/google/callback`). **Webhooks** go to `<PUBLIC_GATEWAY_URL>/hooks/<provider>`.
  In local dev both must be reachable through a tunnel (`cloudflared tunnel --url
http://localhost:4001` for the gateway); see `apps/gateway/README.md`.
- **Read consent** asks for read scopes only; a grant that includes a write scope is
  rejected. **"Allow sending" / "Allow ticket updates"** is a separate consent whose token
  only the executor can decrypt.
- Where a provider accumulates scopes per app (Microsoft, Slack), register a **second app
  for the write consent** (`MS_WRITE_*`, `SLACK_WRITE_*`); otherwise a later read reconnect
  carries the write scope and is refused.
- Webhook shared secrets are stored only as hashes; signatures are checked in constant time.

| Provider         | Sources (item kind)                                                                | How changes arrive                                                                | Writes                            |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| Google (`gmail`) | mail (email), calendar (event), drive (file, metadata only), chat (Workspace only) | Gmail Pub/Sub; Calendar/Drive watch channels; Chat via Workspace Events → Pub/Sub | `gmail.send`                      |
| Microsoft 365    | mail, calendar, teams (chat), onedrive (file), channels (off by default)           | Graph change notifications + delta queries; Teams by watermark                    | `outlook.send`                    |
| Slack            | messages (chat), per workspace                                                     | Events API + `search.messages` delta                                              | `slack.post`                      |
| Atlassian        | jira (ticket), confluence (note), per site                                         | Jira dynamic webhooks; Confluence polled                                          | `jira.transition`, `jira.comment` |
| Notion           | pages (note) — only pages the user shares                                          | Integration webhooks + search delta                                               | —                                 |
| GitHub           | work (issues and PRs involving you) — only repos you install the app on            | App webhooks + search delta                                                       | —                                 |

## Google (Gmail, Calendar, Drive, Chat)

1. Enable APIs: Gmail, Google Calendar, Google Drive, Google Chat, Google Workspace Events,
   Cloud Pub/Sub.
2. OAuth client (Web application) → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, redirect
   `<PUBLIC_API_URL>/oauth/google/callback`. Consent-screen scopes: `gmail.readonly`,
   `gmail.send`, `calendar.events.readonly`, `drive.metadata.readonly`,
   `chat.messages.readonly`, `chat.spaces.readonly`, `openid`, `email`. Gmail and Drive
   scopes are restricted: stay in Testing mode with test users until the app is verified.
3. Gmail push: a Pub/Sub topic (`GMAIL_PUBSUB_TOPIC`) with
   `gmail-api-push@system.gserviceaccount.com` as Publisher; a push subscription to
   `<PUBLIC_GATEWAY_URL>/hooks/gmail` with OIDC auth (`GMAIL_PUBSUB_AUDIENCE`,
   `GMAIL_PUBSUB_SERVICE_ACCOUNT`).
4. Chat push: in the Chat API configuration page, fill in the app name, avatar and
   description (otherwise Chat returns 404 and the source shows "not configured"). Create a
   topic (`GOOGLE_EVENTS_PUBSUB_TOPIC`) with `chat-api-push@system.gserviceaccount.com` as
   Publisher, and a push subscription to `<PUBLIC_GATEWAY_URL>/hooks/gmail/events` with OIDC
   auth (`GOOGLE_EVENTS_PUBSUB_AUDIENCE`, `GOOGLE_EVENTS_PUBSUB_SERVICE_ACCOUNT`).
5. Calendar and Drive need no extra setup: channels push to
   `<PUBLIC_GATEWAY_URL>/hooks/gmail/channel`, which must be **https**. Without https they
   still sync on the 15-minute catch-up.

Users may untick scopes on Google's consent screen; sources whose scopes weren't granted
stay off. Chat is marked unavailable on consumer (gmail.com) accounts.

## Microsoft 365 (Outlook, Calendar, Teams, OneDrive)

1. Entra admin center → App registrations → New: "Accounts in any organizational directory
   and personal Microsoft accounts" (`MS_TENANT=common`).
2. Web redirect `<PUBLIC_API_URL>/oauth/microsoft/callback`; client secret →
   `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.
3. Delegated Graph permissions: `openid`, `offline_access`, `User.Read`, `Mail.Read`,
   `Calendars.Read`, `Chat.Read`, `Files.Read`. For Teams channels (optional,
   `MS_CHANNEL_MESSAGES=1`): `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All` (admin consent).
4. Recommended: a second app with only `Mail.Send`, `User.Read`, `openid`,
   `offline_access` → `MS_WRITE_CLIENT_ID` / `MS_WRITE_CLIENT_SECRET`.
5. The gateway URL must be https (Graph refuses http notification URLs).

Notes: Graph has no per-app token revocation for delegated grants (users remove the app at
myapps.microsoft.com). Personal accounts have no chat APIs, so Teams is skipped for them.
Graph has no delegated delta for chat messages; Teams uses a time watermark plus a
subscription as a trigger, falling back to polling.

## Slack (per workspace)

1. api.slack.com/apps → create an app, enable public distribution.
2. OAuth & Permissions: redirect `<PUBLIC_API_URL>/oauth/slack/callback`. **User** token
   scopes only (no bot scopes): `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`,
   `search:read`. Token rotation optional (supported).
3. Event Subscriptions: request URL `<PUBLIC_GATEWAY_URL>/hooks/slack`; subscribe on behalf
   of users to `message.channels`, `message.groups`, `message.im`, `message.mpim`.
4. Basic Information → `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
5. Recommended: a second app with only `chat:write` → `SLACK_WRITE_CLIENT_ID` /
   `SLACK_WRITE_CLIENT_SECRET`.

To verify on a live workspace: that `search.messages` with only `after:<date>` returns
results, and that message metadata round-trips with user tokens.

## Atlassian (Jira, Confluence — per site)

1. developer.atlassian.com/console/myapps → OAuth 2.0 integration.
2. Permissions — Jira: `read:jira-work`, `read:jira-user`, `manage:jira-webhook`,
   `write:jira-work`; Confluence: `read:confluence-content.all`, `search:confluence`; User
   identity: `read:me`.
3. Authorization callback `<PUBLIC_API_URL>/oauth/atlassian/callback`.
4. Webhooks: set the app's base URL to `<PUBLIC_GATEWAY_URL>`.
5. Settings → `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` (the secret also signs
   webhook deliveries). Distribution → Sharing.

`manage:jira-webhook` is part of the read grant: it only manages the app's own webhooks.
One consent adds one account per site; they share a rotating refresh token. Jira webhooks
cover issues you're assigned or reported; watched issues, mentions and Confluence arrive on
the catch-up sync. Atlassian has no token revocation endpoint for 3LO apps.

## Notion

1. Create a public integration with "Read content" (plus "Read user information" for
   author names). Redirect `<PUBLIC_API_URL>/oauth/notion/callback` →
   `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET`.
2. Webhooks: subscribe `<PUBLIC_GATEWAY_URL>/hooks/notion` (API version pinned in the
   connector). Notion first sends a verification token; the gateway writes it to
   `.dev/notion-webhook-verification-token`. Paste it into Notion's Verify dialog and into
   `NOTION_WEBHOOK_VERIFICATION_TOKEN`, then delete the file.

Users choose which pages to share in Notion's own consent screen.

## GitHub

1. Create a GitHub App: Issues, Pull requests, Metadata = **Read**; user-token expiration
   on. Callback `<PUBLIC_API_URL>/oauth/github/callback`; webhook
   `<PUBLIC_GATEWAY_URL>/hooks/github` with a secret.
2. Subscribe to `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
   `pull_request_review_comment`.
3. `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GITHUB_WEBHOOK_SECRET`.

Users pick repositories when installing the app. If they connect before installing, the
Connectors screen shows "Install the Hub app on your repositories".

## Model providers (Bedrock, Vertex)

- **Bedrock**: region plus an access key ID and secret access key (stored encrypted). Uses
  the Claude Messages API on Bedrock; model ids like `anthropic.claude-sonnet-5` or
  inference profiles. IAM role ARNs are not supported yet.
- **Vertex AI**: project ID, region, and a service-account key JSON (`type:
service_account` only).
- In production a credential is required; the server's own ambient cloud credentials are
  used only in development.
