# Gateway

Receives provider webhooks at `/hooks/:provider` and `/hooks/:provider/:channel` (`POST`, and
`GET` for providers that verify with one), verifies them with the provider's connector
(`verifyWebhook` gets the method, headers, query, channel, parsed body and raw body), answers
handshakes, maps each event to every matching account, inserts an `events` row per account
(deduped on `provider_event_id`), enqueues `sync` for new events only and answers right away.
It does no provider calls and never touches message content.

| Route                             | Result                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /healthz`                    | `200 {"ok":true}`                                                            |
| `POST /hooks/<provider>[/<chan>]` | `204` accepted (also for unknown accounts), `401` failed verification        |
|                                   | or the connector's `reply` (e.g. Graph `validationToken` as `text/plain`,    |
|                                   | Slack `url_verification` challenge as JSON) with its status and content type |
| `/hooks/<unknown or unbuilt>`     | `404`                                                                        |

**Routing.** Each event names its account(s) with exactly one of:

- `externalAccountId` → `accounts(provider, external_id)` (the Gmail address);
- `routeKey` → accounts of that provider whose `route_keys` contain it (Slack team id, GitHub
  installation id, Atlassian cloud id);
- `externalSubId` → the `subscriptions` row with that id; its `kind` is the source to sync.

Disconnected accounts and disabled sources never match. The sync job carries the source
(`{accountId, source?, eventId, reason: 'webhook'}`); without one the account's enabled
sources all sync.

**Subscription secrets.** If an event carries `subscriptionSecret` (Graph `clientState`,
Google `X-Goog-Channel-Token`), `sha256(secret)` is compared in constant time with the matched
subscription's `meta.secretHash` (for `externalAccountId`/`routeKey` events, the account's row
for `event.source`). A subscription that stored a hash also refuses events without a secret.
Mismatches are dropped and logged with ids only.

Dedupe key: `<provider>:<event id>` for the oldest matching account, and
`<provider>:<event id>:<accountId>` for any other account it maps to (the same mailbox
connected by a second user, two users in one Slack workspace). Redelivered events insert
nothing and enqueue nothing. If enqueueing fails the event row is removed and the gateway
answers `500`, so the provider's retry is not swallowed by dedupe.

Run it with `pnpm dev` (all services) or `pnpm --filter @hub/gateway dev` (port `GATEWAY_PORT`, default 4001).

## Offline demo (no Google project)

With `GMAIL_FAKE=1` in `.env`, Gmail is served from recorded fixtures stored in
`<repo>/.dev/fake-gmail.json` (gitignored, shared by every process). Two mailboxes are seeded:
`alex@company.example` ("Work") and `alex.personal@gmail.example` ("Personal"). Connecting
Gmail in the app redirects straight back with a fake code: the first connect is Work and the
second is Personal (or pass a login hint to pick one). In fake mode the gateway accepts
unsigned pushes. Fake mode is refused when `NODE_ENV=production`.

```bash
pnpm dev                                    # api, gateway, workers, mcp
# connect both Gmail accounts in the app, pick a backfill window, then:
pnpm --filter @hub/gateway fake:email --to alex@company.example \
  --subject "Q3 slides by Thursday?" --body "Could you send the Q3 slides by Thursday 5pm?"
pnpm --filter @hub/gateway fake:email --to alex.personal@gmail.example \
  --from sam@gmail.example --from-name "Sam Lee" --subject "Dinner Saturday?" --body "7pm?"
pnpm --filter @hub/gateway fake:email --list  # mailboxes and history ids
```

Each call appends a message to the mailbox (with a `messageAdded` history entry) and POSTs a
Pub/Sub-shaped push to `PUBLIC_GATEWAY_URL/hooks/gmail`. The sync worker then pulls the delta
and the items show up in the Inbox tagged with the right account. Other flags: `--html`,
`--label CATEGORY_PROMOTIONS` (repeatable), `--gateway <url>`, `--no-push`.
Delete `.dev/fake-gmail.json` to reset the mailboxes.

## Real Gmail push (Pub/Sub + tunnel)

Pub/Sub must reach the gateway over public HTTPS, so in local dev you need a tunnel.

1. **Tunnel** the gateway port:
   ```bash
   cloudflared tunnel --url http://localhost:4001
   # or: ngrok http 4001
   ```
   Put the `https://…` URL in `.env` as `PUBLIC_GATEWAY_URL`. Quick tunnels get a new URL on
   every start, so update the push subscription below when that happens (or use a named
   cloudflared tunnel or a reserved ngrok domain).
2. **Topic**: create one, e.g. `projects/<project>/topics/gmail`, and grant
   `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it. Set
   `GMAIL_PUBSUB_TOPIC=projects/<project>/topics/gmail`.
3. **Service account** for push auth, e.g. `gmail-push@<project>.iam.gserviceaccount.com`.
   Set `GMAIL_PUBSUB_SERVICE_ACCOUNT` to its email.
4. **Push subscription** on the topic:
   ```bash
   gcloud pubsub subscriptions create gmail-push \
     --topic=gmail \
     --push-endpoint="$PUBLIC_GATEWAY_URL/hooks/gmail" \
     --push-auth-service-account="gmail-push@<project>.iam.gserviceaccount.com" \
     --push-auth-token-audience="$PUBLIC_GATEWAY_URL/hooks/gmail" \
     --ack-deadline=30
   ```
   Set `GMAIL_PUBSUB_AUDIENCE` to the same audience (`<PUBLIC_GATEWAY_URL>/hooks/gmail`).
   When the tunnel URL changes, run
   `gcloud pubsub subscriptions modify-push-config gmail-push --push-endpoint=… --push-auth-service-account=… --push-auth-token-audience=…`
   and update `GMAIL_PUBSUB_AUDIENCE`.
5. Set `GMAIL_FAKE=0` and restart. The sync worker calls `users.watch` on the first sync of
   each account, and the scheduler renews watches daily (they expire after 7 days).

The gateway verifies each push's OIDC bearer token: Google signature, issuer
`accounts.google.com`, audience `GMAIL_PUBSUB_AUDIENCE`, email `GMAIL_PUBSUB_SERVICE_ACCOUNT`
and `email_verified`. With the audience or service account unset, every push is rejected.
Tokens are never logged; failures log only a short reason.

Test a push by hand: send yourself an email and watch the gateway log for `webhook accepted`.
Missed pushes are covered by the scheduler's catch-up sync every 15 minutes.
