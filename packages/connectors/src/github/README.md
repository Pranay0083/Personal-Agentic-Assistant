# GitHub connector

Read-only. Source `work` (kind `ticket`): issues and PRs involving the user. No write
actions.

## Setup (GitHub App)

1. Go to <https://github.com/settings/apps/new>, or the org's settings, and create a GitHub App:
   - **Callback URL:** `<PUBLIC_API_URL>/oauth/github/callback` (the API's OAuth callback).
   - Leave **Expire user authorization tokens** on. That gives 8-hour tokens with rotating
     refresh tokens.
   - **Webhook URL:** `<PUBLIC_GATEWAY_URL>/hooks/github`. In local dev, use a tunnel:
     `cloudflared tunnel --url http://localhost:4001` or `ngrok http 4001`.
   - **Webhook secret:** a random string, which goes in `GITHUB_WEBHOOK_SECRET`.
   - **Repository permissions:** Issues **Read**, Pull requests **Read**, Metadata **Read**.
     Nothing else, and nothing with write access. `exchange` rejects an installation that
     grants `write` or `admin` on anything.
   - **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review,
     Pull request review comment. Installation events are always delivered.
2. Put the app's values in `GITHUB_APP_ID`, `GITHUB_APP_SLUG` (the URL name),
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

## Connect and install flow

"Only repos you pick" means the repos the user selected when installing the app.

1. The phone opens `github.com/login/oauth/authorize?client_id=…&prompt=select_account`.
   There are no scopes; the app's permissions apply.
2. `exchange` calls:
   - `GET /user`, which sets `externalId` to the user id and `displayName` to the login.
   - `GET /user/installations`, which sets `routeKeys` to the installation ids.
3. `meta` holds `{login, installations:[{id, account}], grantedScopes, needsInstall,
installUrl}`. `grantedScopes` is the installations' permissions, e.g. `issues:read`.
4. If the user has no installation yet, `exchange` still succeeds with `needsInstall: true`.
   The app should then send the user to
   `installUrl = https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. Installing
   delivers an `installation` webhook. Sync stays empty until then.
5. Users can add or remove repos any time from the same page. That delivers
   `installation_repositories`.

## Sync

A user token can't mix issues and PRs in one search. `involves:` doesn't cover pending
review requests, and it doesn't say why an item matched. So each run makes five searches,
all sorted by `updated` ascending:

- `is:issue involves:@me updated:>=T`
- `is:pr involves:@me updated:>=T`
- `is:issue mentions:@me updated:>=T`, which proves `hub:mention`
- `is:pr mentions:@me updated:>=T`, which proves `hub:mention`
- `is:pr review-requested:@me updated:>=T`, which proves `github:review_requested`

The mentions queries are a subset of `involves:`, so they usually return one short page.

Trusted signal labels come only from GitHub metadata and from which query matched, never
from the text:

- `hub:review_requested`: a review request is pending and the PR is open.
- `hub:assigned`: the user is in `assignees`.
- `hub:mention`: a `mentions:@me` hit.
- `hub:from_me`: the user authored it.

`T` is the cursor minus a 10-minute overlap, which covers search-index lag. The cursor is
`{t, seen}`; `seen` skips items already synced inside the window.

- Results are kept only when the repo is in one of the user's installations. Installations
  are read live on every run.
- At most 50 items are returned per run; if more are waiting, the result sets `hasMore`.
- The body is the issue or PR body plus the 5 most recent comments, capped at 16k
  characters.
- A 403 or 429 rate limit becomes a `RetryableError` with the reset time.
- A 401 or a rejected refresh token becomes `ReconnectRequiredError`.
- Refreshed tokens are saved through `ctx.saveTokens`, since the refresh token rotates.

## Webhooks

The gateway verifies `X-Hub-Signature-256` in constant time. It routes by
`routeKey = installation.id` and dedupes on `providerEventId = X-GitHub-Delivery`.

`installation` and `installation_repositories` events also emit a second event,
`<delivery>:sender`, routed by `externalAccountId = sender.id`. A brand-new installation
isn't in any account's route keys yet, so this is how its sync gets triggered. The payload
sets `refreshRouteKeys: true`, so the sync worker calls the connector's `refreshIdentity`.
That re-reads `/user/installations` and returns the new route keys plus
`meta.installations`, `needsInstall` and `installUrl`, which the worker stores on the
account. An installation that gained write permissions is refused.

`ping` and other events are acknowledged and ignored.

## Fake mode (`CONNECTORS_FAKE=1` or `GITHUB_FAKE=1`)

The store is `.dev/fake-github.json`, served through a fake fetch in GitHub's REST shapes,
including 8-hour tokens and rotating refresh. OAuth redirects back with
`code=fake-github:<login>`. Webhooks are signed with `fake-github-secret` unless
`GITHUB_WEBHOOK_SECRET` is set.

```
pnpm --filter @hub/connectors fake:github --action open --repo acme/api --title "Flaky test" --assignee alexkim
pnpm --filter @hub/connectors fake:github --action review --repo acme/web --title "Tidy footer" --reviewer alexkim
pnpm --filter @hub/connectors fake:github --action comment --repo acme/web --number 42 --body "@alexkim ping"
```
