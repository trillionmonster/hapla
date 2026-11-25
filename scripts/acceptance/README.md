# Opt-in acceptance utilities

These scripts are separate from the unit-test suite. Run them from the repository
root and inspect each script's inputs before use. Use an isolated deployment,
test account, and workspace: production-oriented scripts can create conversations,
send messages, access private credentials, or consume provider quota.

| Script | Purpose |
| --- | --- |
| `web-smoke.mjs` | Browser navigation, responsive layout, media, and interaction checks; also exposed as `pnpm web:smoke` |
| `frontend-interactions.mts` | Real Codex browser workflows: composer, steering, queue, BTW, stop/replace, branches, terminal, settings, history, freshness, proxy ownership and logout |
| `preview-manager.mts` | Proxy rule creation/editing, fixed browser URLs, another account's read-only global share, public key access, rotation/revocation, origin isolation, logout, actual Nginx, SSE and WebSockets |
| `first-question.mts` | First-prompt paste and file selection, failed upload retention, retry into the same session, a real Codex image answer, phone newline and IME confirmation |
| `session-state.mts` | Fresh-device execution settings, concurrent field sync, branch isolation, durable queue edits, failed POST retention and same-ID retry with real Codex/local Responses |
| `session-state-native.mts` | Native model/effort default reset and branch model retention using the local Responses fixture |
| `git-workbench-loading.mts` | Real Git reads over encrypted RPC, legacy-session daemon fallback, unsupported workers, non-repositories, independent history loading, read timeout and draft-preserving retry; no model requests |
| `session-navigation.mts` | Session-list return after direct links, reloads, conversation switches and workbench visits; isolated synthetic account, no agent requests |
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

### Proxy manager and first-question regressions

The two focused scripts above use the same Docker/stack and private credential
guards. `first-question.mts` consumes real model quota; it creates an image fixture
in the browser, simulates a paste event, injects one failed upload, retries through
the UI and requires a completed native Codex turn with the image's text. The
clipboard event and IME events are browser simulations, not operating-system tests.
`PROFILE=desktop`, `android` and `iphone` select desktop Chromium, touch Chromium
and touch WebKit respectively. Keep a separate output directory per profile.

For the proxy script, use real dev Nginx and a per-handle hostname template on the
dev server, such as `{handle}.preview.localhost`. Point
`HAPLA_ACCEPTANCE_WEB_URL` at the main dev browser origin. Chromium accepts
`HAPLA_PREVIEW_TEST_RESOLVER` host mapping rules. WebKit uses ordinary dev DNS.
For `*.localhost`, WebKit resolves to the CLI container's loopback even when an
`/etc/hosts` override exists; use an HTTP(S) forwarder inside that container from
loopback to the real dev Nginx, preserving Host and the external protocol/port.
These are test-container settings, not host or
production DNS changes. All rule/key mutations use the browser UI. Direct API
calls are account fixtures, independent state reads, negative authorization
checks and fixture cleanup. The proxy workflow also calls the actual STDIO MCP
bridge to verify that an agent update retains sharing, rejects a now-stale UI
revision without losing its draft, and logs out the second account to invalidate
its isolated-origin grant and existing streams. Exposed shared entries must omit target/workbench configuration.

Recordings, screenshots and action logs stay in ignored evidence directories.
Share keys are masked in the manager by default. Do not publish evidence that
reveals a live key or credentials. Rebuild Web with an empty `HAPLA_SERVER_URL`
and `EXPO_PUBLIC_HAPLA_SERVER_URL` when testing same-origin browser routing;
the CLI container's internal `http://server:3005` address is for the daemon only.

## Coding workbench regression

`coding-workbench.mts` exercises the actual Web, relay, daemon, Git repositories,
and pinned native Codex App Server. A deterministic local Responses service
supplies model replies and tool calls; it requires no provider login or paid
model requests. PR creation/check display use a fixture `gh` executable rather
than writing to a live code host. Neither fixture replaces Hapla's production
RPC handlers or its real Git commands.

Use `deploy/Dockerfile.dev` and `scripts/acceptance/compose.coding.yml` with project
name exactly `dev-hapla`. Check the ports and resource ownership first; never
reuse online account or workspace data. Keep a private env file with
`HAPLA_MASTER_SECRET`, `CODEX_VERSION` from `codexProtocolSnapshot.json`, and optional
free `CODING_WEB_PORT`/`CODING_SERVER_PORT` values (defaults 23345/24005). On a host
with exhausted Docker address pools, add a private Compose override selecting an
unused subnet. Keep the complete Compose file list in every command.

Start `coding-cli`, install dependencies and build inside it. Export Web with
`env -u HAPLA_SERVER_URL pnpm web:build` so the browser uses its own origin
instead of the Docker-only Server address. Then start
`coding-server` and `coding-web`. Inside the runner, execute:

```bash
HAPLA_ACCEPTANCE_STACK=dev-hapla PROFILE=desktop \
HAPLA_ACCEPTANCE_OUTPUT=/repo/artifacts/coding-browser/desktop \
node_modules/.bin/tsx --tsconfig packages/hapla-cli/tsconfig.json \
  scripts/acceptance/coding-workbench.mts
```

Run `desktop`, `android`, and `iphone` sequentially with separate output paths.
The suite checks light/dark theme changes, page width, code visibility in the
first mobile viewport, full paginated UTF-8 text, and bounded formatted diff rows
as well as the Git and native conversation workflows.
These are Chromium desktop/Android and WebKit/iPhone emulations, not physical
phone or system-keyboard validation. `CHROMIUM_PATH` can select an installed
Chromium; otherwise the development image uses Playwright's bundled browser.
The script creates its own synthetic account, credential store, repository and
local bare remote in the isolated runner. Use a dedicated runner: it intentionally
writes that runner's agent fixture config and Hapla credentials. It never copies
a personal login. Preserve screenshots, video and `actions.ndjson` in ignored
artifacts. The CI workflow `coding-browser.yml` runs the same sequence.

Run `git-workbench-loading.mts` with the same Docker command and each profile to
verify data loading and failures separately from native agent behavior. It uses
an isolated account, real temporary Git repositories, and encrypted worker RPC;
selected handlers delay or fail to exercise the UI. Its timeout case waits for
the actual client deadline. It records screenshots, actions, and video without
personal account credentials or model requests.

## Conversation state regressions

Run `session-state.mts` and `session-state-native.mts` inside the verified
`dev-hapla` CLI container after builds have completed. Do not run a CLI build or
unit-test global setup concurrently with browser acceptance: they replace the
CLI output directory. Both scripts create synthetic credentials and use only the
local Responses transport; no personal authentication or paid provider is needed.
Set unique test-only `HAPLA_HOME_DIR` and `CODEX_HOME` paths per invocation,
`HAPLA_ACCEPTANCE_STACK=dev-hapla`, `HAPLA_SERVER_URL=http://server:3005`, and
`HAPLA_ACCEPTANCE_OUTPUT` under ignored `artifacts/`. The browser script also uses
`HAPLA_ACCEPTANCE_WEB_URL` (default `http://web:8080`) and `PROFILE=desktop`,
`android` or `iphone`. Android uses Chromium touch emulation and iPhone uses
Playwright WebKit; these are engine/device simulations, not physical devices.
Each browser run records actions, screenshots, video and an explicit result.
The same workflow checks manual resume and Web/daemon continuation, including a
failed POST carried to a replacement runtime with its original submission ID.
Phone runs also assert landscape settings bounds, operate the first setting
inside the scrollable panel and capture the dark variant.
