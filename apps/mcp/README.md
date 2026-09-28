# apps/mcp: the Hub MCP server

A remote MCP server (Streamable HTTP + OAuth 2.1) that lets Claude, Claude Code and
other agents read the context a user allows and propose actions the user approves on
their phone. It never executes anything: writes happen only in `apps/workers/executor`.

```
pnpm --filter @hub/mcp dev      # listens on MCP_PORT (4002), serves PUBLIC_MCP_URL
```

Needs Postgres, Redis and `LOCAL_MASTER_KEY` (or KMS) from `.env`, same as the other services.

## Connect Claude Code

```
claude mcp add --transport http hub http://localhost:4002/mcp
```

Then run `/mcp` in Claude Code and choose **hub → Authenticate**. A browser tab opens
on Hub's sign-in page (see below).

## Connect Claude (custom connector)

Claude reaches the server from the internet, so it needs an HTTPS URL:

```
cloudflared tunnel --url http://localhost:4002        # or: ngrok http 4002
```

Set `PUBLIC_MCP_URL=https://<your-tunnel-host>/mcp` in `.env` and restart the server
(the URL goes into the OAuth metadata, and requests for any other Host are refused).
In Claude, go to **Settings → Connectors → Add custom connector** and paste that URL.
No client ID or secret is needed; Claude registers itself.

## What the approval looks like

1. The client registers (dynamic client registration) and opens `/authorize` with PKCE.
2. The page shows the client's name and where you'll be sent back, and asks for your
   **Hub email**. Nothing else: no password.
3. Your phone gets a push, **"Connect Claude Code?"**, and the request shows in
   **Approvals**. Only allow it if you just started connecting. The browser tab waits
   and moves on as soon as you decide.
4. On **Allow**, the tab returns to the client with a one-time code (10 minutes). The
   client exchanges it for an access token (1 hour) and a refresh token (rotated on
   every use). On **Deny**, or after 10 minutes without an answer, the tab says so.

The page gives the same answer whether or not an email has an account, and the form
is rate-limited per IP and per email.

Afterwards the client appears on the **Permissions** screen as `mcp:<id>`. What it can
read or propose follows your preset and per-account rules; personal accounts stay
hidden unless you grant temporary access. Revoke it on the phone (or via the OAuth
revocation endpoint) and every later request is rejected.

## Tools

| Tool                 | What it does                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `search_context`     | Searches titles, summaries and authors in the accounts and kinds this client may read. Lists what was withheld. |
| `get_my_tasks`       | Tasks from readable sources plus tasks you added yourself.                                                      |
| `get_thread`         | The whole thread for an item. Bodies only if you haven't turned on "keep bodies local".                         |
| `get_project_status` | Open and recently done tasks for a project, with recent related items.                                          |
| `propose_action`     | Creates a pending proposal (today: `gmail.send`) and asks you on the phone. Retries never duplicate it.         |
| `request_access`     | Asks you for temporary read access (up to 4 hours) to a withheld source.                                        |

Every call re-checks `can()` from `@hub/policy` and writes an `audit_log` entry, denials
included (ids only). Everything from email, chat, tickets and notes is wrapped with
`fenceUntrusted()` before it goes back to the model. When Hub is paused, every tool
refuses.

## Endpoints

| Path                                                                                 | Purpose                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `POST /mcp`                                                                          | Streamable HTTP (stateless; GET/DELETE answer 405)   |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource` | Protected resource metadata (RFC 9728)               |
| `/.well-known/oauth-authorization-server`                                            | Authorization server metadata (RFC 8414)             |
| `POST /register`                                                                     | Dynamic client registration (RFC 7591)               |
| `GET/POST /authorize`, `POST /authorize/status`                                      | Consent page and the status poll behind it           |
| `POST /token`                                                                        | `authorization_code` (PKCE S256) and `refresh_token` |
| `POST /revoke`                                                                       | Token revocation (RFC 7009)                          |

Only hashes of client secrets, codes and tokens are stored.
