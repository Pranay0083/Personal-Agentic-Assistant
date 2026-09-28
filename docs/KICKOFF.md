# Prompts to paste into Claude Code

Start Claude Code in the repo root so it picks up `CLAUDE.md`. Paste one prompt at a
time and review the result before moving on.

## 1. First session: plan, then scaffold

```
Read CLAUDE.md, docs/ARCHITECTURE.md and docs/PLAN.md. Don't write code yet.
Tell me your plan for Phase 0, the files you'll create, and anything in the spec
that's unclear or that you'd change. Then wait for my go-ahead.
```

After you agree on the plan:

```
Go ahead with Phase 0. Commit in small steps. When done, run the Phase 0
acceptance check and tick the boxes in docs/PLAN.md.
```

## 2. Each later phase

```
Start Phase N from docs/PLAN.md. Plan first and show me the plan. Follow the
non-negotiable rules in CLAUDE.md. Write fixture-based tests for connectors,
policy and executor. Finish by running the acceptance check and ticking PLAN.md.
```

## 3. Mobile screens from the designs

```
Build the <ScreenName> screen in apps/mobile from design/screens/<File>.dc.html.
Read design/README.md first. Match the layout, colors, fonts and spacing, use
real data from the API, and keep touch targets at least 44px.
```

## 4. Review pass (run after every phase)

```
Review the changes in this phase against the non-negotiable rules in CLAUDE.md.
Look especially for: writes outside the executor, missing can() checks, untrusted
content reaching a model unfenced, secrets or message text in logs, and missing
idempotency. List problems with file and line, then fix them.
```

## What you'll need on hand

- A Google Cloud project with the Gmail API and Pub/Sub enabled, an OAuth client,
  and a Pub/Sub topic (Phase 1)
- An Anthropic API key (Phase 2)
- An Expo account for push notifications (Phase 2)
- A tunnel for local webhooks: `cloudflared` or `ngrok`
