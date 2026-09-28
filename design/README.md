# Screen designs

Each `.dc.html` file in `screens/` is one phone screen (390 × 844) from the design
canvas. They're HTML with inline styles, so the exact colors, sizes, spacing and
copy are all readable in the markup. The `<script>` at the bottom of each file
holds the sample data and the interactive states (what's selected, what happens on
tap). `{{ name }}` holes are filled from that script's `renderVals()`.

Treat them as the visual spec, not as code to copy. Build the real screens in
React Native.

## Screens

| File | Screen |
|---|---|
| `Welcome` | Sign in, privacy promises |
| `Role` | Onboarding 1: what do you mostly do |
| `Connect` | Onboarding 2: connect multiple accounts per service |
| `Scope` | Onboarding 3: per-account nickname, color, filters, history window |
| `Presets` | Onboarding 4: permission preset, stricter for personal accounts |
| `ModelsSetup` | Onboarding 5: recommended, own provider (8 providers), local |
| `Agents` | Onboarding 6: MCP link for Claude, command for Claude Code |
| `FirstWin` | Onboarding 7: confirm first tasks, enable notifications |
| `Main` | Today tab: brief, needs you, next up, ask bar |
| `Inbox` | Inbox tab: filters, account switcher, needs you / FYI |
| `Tasks` | Tasks tab: overdue, today, later |
| `Approvals` | Approvals tab: drafts, ticket changes, permission requests |
| `Control` | Control tab: kill switch, settings hub |
| `Connectors` | Accounts per service with status |
| `Permissions` | Per-agent, per-source access levels, temporary grants |
| `Models` | Model per agent, providers, keep email local |

## Design tokens

- Background `#F6F4EF`, cards `#FFFFFF`, borders `#E4E0D6`, dividers `#EEEAE1`
- Ink `#1B1A17`, secondary text `#5E5A52`
- Teal (safe, done, primary) `#1F6F6B`, tint `#E3EFEC`, dark text on tint `#174F4C`
- Amber (needs you) `#9A4F0E`, tint `#F7EBDD`, dark text on tint `#7A3E0B`
- Account colors: `#1F6F6B`, `#3B5BA9`, `#6B4FA0`, `#8A5A2B`
- Type: Instrument Serif (titles), IBM Plex Sans (body), IBM Plex Mono (labels, source tags)
- Radius: cards 14–16, buttons 10–14, chips 4 (source tags) or full (pills)
- Touch targets at least 44px
