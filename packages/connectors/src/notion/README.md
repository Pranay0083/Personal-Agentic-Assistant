# Notion connector

Read-only. Source `pages` (kind `note`). No write actions.

## Setup

1. Go to <https://www.notion.so/profile/integrations> and create a **public** integration.
   Capabilities: **Read content** only, plus **Read user information including email
   addresses** if you want author names. Leave every insert, update and comment capability
   off.
2. Add the redirect URI `<PUBLIC_API_URL>/oauth/notion/callback` (the API's OAuth callback).
3. Put the OAuth client id and secret in `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`.
4. Open the integration's **Webhooks** tab and create a subscription to
   `<PUBLIC_GATEWAY_URL>/hooks/notion`. In local dev, use a tunnel: `cloudflared tunnel --url
http://localhost:4001` or `ngrok http 4001`. Subscribe to the page, database and data
   source events. Set the subscription's API version to `2026-03-11` so it matches the
   `Notion-Version` the connector pins.

## Verification handshake

When the subscription is created, Notion POSTs `{"verification_token":"secret_…"}`. That
request is unsigned. The gateway handles it like this:

- If `NOTION_WEBHOOK_VERIFICATION_TOKEN` is set, a handshake with any other token is
  rejected (anyone can send one).
- Otherwise it answers 200 and emits no events.
- Outside production it creates `.dev/notion-webhook-verification-token` (mode 0600) only
  if the file does not exist yet; it never overwrites it. In production nothing is
  written: capture the token with a non-production gateway, or resend it from Notion.
- It logs a hint and an 8-character sha256 fingerprint. The token itself is never logged.

Then the operator:

1. Pastes the token into Notion's **Verify** dialog.
2. Sets `NOTION_WEBHOOK_VERIFICATION_TOKEN` to it and restarts the gateway.
3. Deletes the file.

After that, each event must carry `X-Notion-Signature: sha256=<HMAC-SHA256(raw body,
token)>`. The signature is compared in constant time. Events route by
`routeKey = workspace_id` and dedupe on the event `id`. Payloads carry ids only. Comment
events are acknowledged and not synced.

## Sync

Each run calls `POST /v1/search` for pages, sorted by `last_edited_time` descending. It
pages until results are older than the cursor minus a 5-minute overlap, which covers
search-index lag. Pages are then processed oldest first, at most 25 per run; if more are
waiting, the result sets `hasMore`.

The cursor is `{t, seen}`. Notion rounds edit times down to the minute, so a page is only
marked as seen once its minute has closed. Otherwise a second edit in the same minute
would be missed.

Bodies come from the page's blocks, flattened to text:

- Children are fetched recursively, to a depth of 3.
- Output is capped at 20k characters and 25 requests per page.
- Child pages are not descended into.

Requests are spaced 350 ms apart (about 3/s). A 429 `Retry-After` of 30 s or less is
waited out in-process; a longer one is passed to the queue as a `RetryableError`.

## Account identity

- `externalId`: `<workspace_id>:<owner user id>`
- `routeKeys`: `[workspace_id]`
- `meta`: `{workspaceId, workspaceName, botId, ownerUserId}`

Tokens don't expire. `revoke` calls `POST /v1/oauth/revoke`.

## Fake mode (`CONNECTORS_FAKE=1` or `NOTION_FAKE=1`)

The store is `.dev/fake-notion.json`, served through a fake fetch in Notion's REST shapes.
OAuth redirects straight back with `code=fake-notion:<workspace>`. Webhooks are signed with
`fake-notion-token` unless `NOTION_WEBHOOK_VERIFICATION_TOKEN` is set.

```
pnpm --filter @hub/connectors fake:notion --title "Standup" --text "Ship it" --todo
pnpm --filter @hub/connectors fake:notion --page <id> --text "One more thing"
pnpm --filter @hub/connectors fake:notion --list
```
