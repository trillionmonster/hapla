# Opt-in acceptance utilities

These scripts are separate from the unit-test suite. Run them from the repository
root and inspect each script's inputs before use. Use an isolated deployment,
test account, and workspace: production-oriented scripts can create conversations,
send messages, access private credentials, or consume provider quota.

| Script | Purpose |
| --- | --- |
| `web-smoke.mjs` | Browser navigation, responsive layout, media, and interaction checks; also exposed as `pnpm web:smoke` |
| `frontend-interactions.mts` | Real Codex browser workflows: composer, steering, queue, BTW, stop/replace, branches, terminal, settings, history, freshness, proxy ownership and logout |
| `session-cache-smoke.mjs` | Synthetic browser fixture using the actual sync/store/reducer code |
| `session-cache-production-smoke.mjs` | Production UI/cache behavior with an explicitly prepared test account |
| `reasoning-summary-production-smoke.mjs` | Real reasoning-output UI acceptance |
| `seed-conversation-fixture.mjs`, `seed-session-cache-production.mjs` | Prepare test records for isolated acceptance |
| `analyze-session-cache-heap.mjs` | Analyze an existing private heap snapshot |
| `encode-smoke-recording.py` | Encode an acceptance recording |
| `fixtures/session-cache.ts` | Browser fixture source; synthetic platform adapters |

Browser scripts use `CHROMIUM_PATH` when configured, otherwise `chromium` on `PATH`.
Point them at a prepared test deployment, for example:

```bash
CHROMIUM_PATH=/path/to/chromium pnpm web:smoke --url=http://127.0.0.1:12345
```

Keep screenshots, traces, logs, seeds, heap snapshots, and installation-specific
reports in ignored local storage such as `.runtime/` or `artifacts/`.

## Frontend interaction acceptance

Run `frontend-interactions.mts` inside the verified `dev-hapla` CLI container, with
the current Web build, Server, daemon and pinned Codex version. It consumes real
provider quota. This is browser support acceptance, not a replacement for the
CLI's primary agent integration tests. Screenshots alone do not pass it.

Prepare a private JSON fixture containing `token`, `secret` (base64url account
encryption key), `otherToken`, and `historySessionId`. Both accounts must be test
accounts in this stack; the history fixture must contain the 140 numbered test
questions, without waking that conversation. The selected workbench must be
online, own `/workspace`, and have its own working Codex login. Keep the fixture
mode `0600`; never commit it or include it in exported evidence.

Install Chromium, its fonts, Playwright Core, and the Playwright FFmpeg helper
inside the development container. Set `CHROMIUM_PATH` and optionally
`HAPLA_PLAYWRIGHT_MODULE` to those installed paths. For example, using the actual
verified development Compose file:

```bash
docker compose --project-name dev-hapla -f .runtime/dev-hapla/compose.json exec \
  -e HAPLA_ACCEPTANCE_STACK=dev-hapla \
  -e HAPLA_ACCEPTANCE_CREDENTIALS=/repo/.runtime/dev-credentials.json \
  -e HAPLA_ACCEPTANCE_OUTPUT=/repo/artifacts/frontend-interactions \
  -e STAGE=main cli \
  /repo/node_modules/.bin/tsx --tsconfig packages/hapla-cli/tsconfig.json \
  scripts/acceptance/frontend-interactions.mts
```

Use the same output directory and run these stages **sequentially**:
`main`, `queue-safety`, `controls`, `questions`, `freshness`, `history-mobile`,
`preview`, `logout`, `contexts`. `main` creates a fresh conversation through the UI; subsequent
stages use its saved identifier. `HAPLA_ACCEPTANCE_WEB_URL` selects the browser
origin (default `http://web:8080`); `HAPLA_SERVER_URL` is the container API origin.
The script refuses to run outside Docker or without the explicit stack setting.
The `preview` stage includes root-level login navigation, a form POST, scoped
upstream cookies, and a post-login redirect. Run it through the actual deployment
Nginx configuration behind external HTTP and HTTPS ports as well as the Node Web
server; otherwise Nginx's expansion of redirects can silently drop an external
port or downgrade TLS while the rest of the page still passes.

The browser clicks, types, pastes and submits actual UI controls. Auth/history and
upstream web servers are fixtures; feature mutations do not bypass the UI with
direct RPCs. Read-only decrypted API state independently verifies native threads,
turns, receipts and durable queues. Terminal checks require standalone output
lines, not matching text echoed in an unexecuted command. Recordings and
`actions.ndjson` retain actions, expected outputs, case results and state evidence;
`videos.ndjson` maps recordings to stages. They omit credentials and raw traces.
Browser exceptions fail a stage, even if a screenshot looks correct.
The additional `contexts` stage asks for remembered values without including the
expected answer in its prompts. It correlates a new completed input receipt and
the newest rendered reply when checking main-session and branch memory, and
checks an independently generated side-chat word after stopping and resuming BTW.

Failures retain screenshots and body text. Correct the defect, rebuild inside
the development container, and rerun its full workflow. `RESUME_CASE` supports
diagnosis from a numbered case in the current fixture; a final complete run must
omit it. Mobile coverage uses Chromium touch emulation, actual tap-to-send, and
reduced viewport heights; it does not establish behavior on physical devices or
other browser engines.

For full phone workflows, set `STAGE=mobile` and
`HAPLA_ACCEPTANCE_MOBILE_PROFILE=android` or `iphone`, using a separate output
directory for each. Android uses Chromium with a 360×800 touch viewport; iPhone
uses Playwright WebKit at 390×844 with iPhone device settings. Install WebKit and
its dependencies inside the same dev container before running the iPhone profile.
These workflows create their own conversation through the UI and use touch taps
for mode menus, sends, queue actions, sidebar controls and interruptions. They
also exercise native structured questions, history reuse, proxy interactions,
offline retry, live following, landscape and reduced-height layouts. Pointer
events record `pointerType: touch`. Screenshots use CSS pixel dimensions.
The phone suite also opens history/settings from the compact input menu, stops
an active main task while retaining an unsent draft, opens both real attachment
pickers and cancels them, and double-taps the original Send coordinates to check
that the second tap does not become an unintended stop. History pagination waits
for newly loaded entries or the end marker rather than a fixed delay.

Engine/device emulation does not establish physical Android/iOS behavior. It
does not launch the actual Safari app, open a real operating-system keyboard,
exercise native Chinese IMEs, or validate the long-press system paste menu.
