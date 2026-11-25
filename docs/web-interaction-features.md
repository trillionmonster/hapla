# Web interaction features

## Codex follow-ups and interruption

The composer names each delivery mode explicitly. Ordinary messages default to
**补充当前任务**; asking a question while Codex works no longer requires stopping it.

The Web toolbar aligns with the transcript and input. Its delivery menu holds the
four modes; the queue count opens an editor on demand, and the overflow menu
contains the branch action. Pending items do not permanently occupy the chat.
BTW opens an independent side pane on desktop. Narrow screens use a floating
pane measured above the actual composer, leaving the input available. Closing
the pane preserves the side conversation and returns its composer to the main
conversation; deleting a side chat is a separate action. Escape dismisses the
current popup before closing the side pane or invoking any task interruption.

| Control | Behavior | App Server mechanism |
| --- | --- | --- |
| 补充当前任务 | Add instructions to the running turn; start a new turn when idle | `turn/steer` with the expected turn ID, or `turn/start` |
| 排队下一轮 | Run each queued message as a separate turn after the current task | A durable Hapla queue feeding `turn/start` |
| 旁问 BTW | Answer in a separate conversation while the main task continues | A separate connection and `thread/fork`, with copied goal continuation disabled |
| 停止任务 | Cancel the selected active turn and pause pending input | `turn/interrupt`, scoped to the captured runtime/thread/turn |
| 停止并发送 | Stop the captured active turn, then prioritize this new message | Explicit interrupt followed by a new turn |
| 新分支 | Save an independent sibling branch without stopping or switching the main task | `thread/fork` |

BTW conversations retain their own context and can be continued, stopped, or
closed independently. They default to read-only with no automatic approvals.
They inherit the main conversation at creation, including a bounded text snapshot
of the unfinished turn when its native fork has not persisted that context yet; later side answers are not
silently injected into the main task. Closing a side conversation removes its
Hapla panel, not the main conversation. Main-branch switching and editing an
older question retain their existing explicit fork/switch workflow.

While a task runs, **Enter** uses the selected mode and **Tab** queues the draft
when no completion menu is open. Escape first dismisses a popup; a nonempty draft
is preserved. The explicit red stop control always means cancellation.
On touch Web devices, Enter inserts a newline in both the new-session prompt
and existing conversation composer. Tap the send button to submit a message;
returning to a physical-keyboard desktop retains Enter-to-send behavior.

On phones the delivery selector, queue and BTW toggle share one row inside the
input card. Settings, full question history, file/image attachments, workspace
status and branch creation are available from **更多输入操作**. Touch controls
use short labels while retaining their full accessible names. Connection and
permission summaries no longer occupy a separate colored row.

When the main task is running and the draft is empty, the primary action reads
**停止主任务**. Typing a draft restores Send and moves explicit stop into the
more menu; stopping preserves that draft. A short guard after Send prevents a
rapid second tap on the same location from unintentionally stopping the task.
The compact BTW header keeps its new/stop/close actions together. At very low
heights it becomes a single header above the measured input card.

Commands are `/steer text`, `/queue text`, `/btw text` (alias `/side text`),
`/interrupt text` for stop-and-send, `/stop` to cancel, and `/fork` to create a
branch. Bare `/steer`, `/queue`, `/btw`, and `/side` select a mode.

Queued items support edit, reorder, delete, pause/resume, and immediate injection.
Receipts distinguish queued, submitted, steered, completed, canceled, and failed
input. Provider failures and interrupted runtime recovery pause ambiguous input
for explicit retry rather than silently sending it again. Stale stop targets are
rejected so a delayed click cannot cancel a newer turn.

Codex's own CLI distinguishes steering, queuing, and side chats. See the official
[steering and queuing guide](https://learn.chatgpt.com/docs/prompting#steering-and-queuing),
[side-chat command](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side),
and [App Server steering contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).
Hapla exposes these behaviors through its Web controls; it does not forward
slash-command text to the model as an imitation of a native command.

## Conversation and terminal controls

- Settings and question history use bounded, bordered surfaces distinct from the
  conversation. History scans the current conversation across runtime generations
  and the active branch, independently of the bounded live message window. Load
  earlier pages to reach every question; search filters the questions loaded so far.
- Reaching the message tail resumes live following. Reconnect replacement of a
  raw message window does not pin the live view to an evicted reading anchor.
  Scrolling back still preserves the historical reading position.
- Terminal paste uses the browser's trusted paste event, including Ctrl+V,
  Ctrl+Shift+V, and Shift+Insert. Ctrl+C/D/A/E/K/U/R continue to the PTY;
  terminal shortcuts do not activate global Hapla shortcuts. Input writes stay in
  order so bracketed-paste delimiters cannot overtake the pasted content.
- Attachments show file name, size, and upload state before sending. A
  single-choice question can be answered by selecting an option; multi-question
  and free-text requests require explicit submission.
- Conversation execution settings are shared through the encrypted conversation
  root, across browsers and replacement runtimes. Field changes use versioned
  compare-and-swap, preserving concurrent changes to other fields. Model,
  reasoning, Fast, verbosity and Plan choices are explicit intent; omitted fields
  inherit the native runtime, while an explicit default clears the override.
  Failed discovery does not erase a selection. Model options come from the
  installed CLI; actual model/reasoning/permission state is published separately.
- Reply settings apply to the next main turn and the current BTW submission.
  Steering retains the running turn's settings. The settings panel and steering
  hint state this boundary. BTW remains read-only regardless of the main task's
  permissions. An outer sandbox never expands the requested approval policy.
- Sending clears a draft only after a durable server acknowledgement. Encrypted
  pending messages are namespaced by server/account and retain the same local ID
  across failures and reloads. Replacement runtimes re-encrypt the pending record
  with their own key while preserving its submission ID; conversation rendering
  merges recovered copies by that ID. Ambiguous submissions require explicit retry.
  Upload and HTTP failures preserve the composer; quota or storage errors surface.
- Every direct, queued and steered Codex input checks its branch before execution.
  A refused cross-branch submission remains available for recovery. Saved queue
  edits append an encrypted, revisioned text record targeting the original
  message; transcript and full question history project the latest revision,
  including when pages arrive in reverse order.
- Editing history uses the durable native turn ID associated with the server
  message, never its position in the visible window. Legacy text matching must
  be unique; repeated prompts and mid-turn steering edits require an explicit
  safe boundary instead of guessing.
- A paused queue stays paused when sending a new direct message, replacing a
  task, or immediately sending one selected queued message. Only “继续队列”
  resumes the remaining items. Failed inputs require an explicit retry.
- A rejected queue edit preserves the editor and draft. Reopen the current
  version after a concurrent change, then save again. Encrypted command errors
  are surfaced even when the relay successfully delivered the RPC response.
- If the browser explicitly reports being offline, new RPC commands fail before
  encryption or ACK registration, even if an old WebSocket still appears open.
  The composer retains its draft for retry after connectivity returns; running
  backend tasks continue. An online browser flag alone does not prove that the
  server is reachable, so the transport checks and deadlines remain in effect.
- Settings and history popovers size themselves to the space above the composer,
  below the application header. Landscape and short screens scroll within the
  panel, preserving access to the first controls instead of clipping them.
- On short mobile viewports the BTW panel compacts its controls and hides its
  picker when necessary, keeping the main composer and stop/close actions usable.
  With very little remaining height it becomes a header with reachable stop and
  close controls. Low-height touch layouts also condense the branch bar so its
  headings do not overlap the composer toolbar.
- Voice input is temporarily hidden in both existing and new conversations by
  `VOICE_INPUT_ENABLED` in the Web feature flags. Its implementation remains available.

## Persistent development page proxy

Open **代理管理** from the desktop sidebar or Settings on a phone. The list includes
**我创建的** and **共享给我的** filters, search, direct Open links and a rule editor.
Each registration maps one stable handle to one workbench and one HTTP(S) target,
including its port and optional base path. Select a workbench that can reach the
service, enter a name and target, choose an access scope, then **保存规则**.
Updating the target preserves the handle and reconnects existing live streams. Unsaved rules survive responsive layout changes within the same account, in memory only. Deleting a registration invalidates its
links without stopping the actual upstream service. A disconnected workbench
returns a retryable error; the fixed entry resumes when it reconnects.

Links use `/preview/<handle>/` resolved against the browser's current Hapla origin,
including the actual scheme and externally forwarded port. Click the service name
or **打开服务** to verify the current account and open the upstream. Copying a link
does not change its access permissions. The conversation's **预览** screen also
opens existing registrations directly and links to the full manager; local HTML
files retain their existing isolated snapshot preview.

| Scope | Who can open | Management |
| --- | --- | --- |
| 仅自己 (default) | The owning authenticated account | Owner only |
| Hapla 全部用户 | Every authenticated account on this Hapla instance; listed under shared services | Owner only |
| 公网凭密钥 | Anyone holding the generated key, without a Hapla login or the outer site password | Owner only |

There is no anonymous, unkeyed scope. Save the key mode, then choose **生成共享密钥**.
The random key is returned only at generation and masked by default; copy it or the keyed share URL before
closing the editor. The database stores a hash, and list APIs never disclose raw
keys. Keyed URLs put the key in the fragment, not the HTTP path or query. The
trusted entry page consumes and removes the fragment before opening the service.
An unkeyed link presents a key input. **重新生成密钥**, **撤销密钥**, a scope change,
or deletion invalidates old keys and grants on subsequent HTTP requests and
WebSocket handshakes, and closes existing proxy HTTP streams and WebSockets. Target updates preserve existing grants and the entry URL.

Sharing requires `HAPLA_PREVIEW_HOST_TEMPLATE`, for example
`{handle}.preview.example.com`. Configure wildcard DNS/TLS and forward these hosts
to the same Web service through every proxy layer. Hapla preserves the browser's
actual protocol and port when opening the isolated host. Each handle has a
separate browser origin, so upstream applications cannot read the main Hapla
origin's account keys or another handle's storage. Without this configuration,
existing owner-only paths remain available and the manager disables sharing.
Configuration changes are deployment work and require the appropriate authorization;
development verification uses dev-only hosts and ports.

The trusted entry verifies the account or share key, then exchanges a signed,
handle-scoped grant on the isolated origin for an HttpOnly cookie. Grants expire
after at most 24 hours; reopen the original entry to renew. Account-based grants
also belong to the current browser login lease. Logout or account switching
revokes that lease and closes its existing HTTP/WebSocket streams on isolated
hosts, while another device and anonymous keyed viewers retain their own access. Every HTTP request and
WebSocket handshake rechecks the current access version. A grant is not a Hapla
API bearer token. Forwarding uses the **owner's** workbench even when the viewer
is another account. Shared list entries expose the name and fixed handle, without
the owner's target IP, workbench ID or editing configuration. Hapla account authorization
headers and cookies are stripped before upstream forwarding. Isolated services
retain their own Basic/Bearer authentication headers.

Agents can use `register_web_preview` and `list_web_previews`; their relative links
use the current browser entry. Reusing a workbench/name or updating a handle keeps
the URL. Agent updates preserve an existing sharing scope; agent-created entries
default to private. The Codex STDIO MCP bridge must discover and call these tools
through the actual transport, not just the underlying HTTP server.

The daemon tunnels live HTTP, POST bodies, binary data, SSE, and WebSockets.
HTML receives a routing bridge for root-relative fetch, modules, styles and HMR;
Web serving layers redirect root resources using the preview referrer. Additional
HTTP/HTTPS forwarding layers must carry `/preview/` and WebSocket traffic,
retain the external Host or X-Forwarded-Host, and retain the first external
X-Forwarded-Proto value. The Web proxy normalizes comma-separated forwarding
chains, including when an intermediate proxy rewrites its internal Host.
Nginx uses relative redirects to retain the actual external scheme and port.
Browser acceptance includes real Nginx, root navigation, login form POST, cookies,
post-login redirects, target replacement, sharing authorization and revocation.

Upstream CSP and embedding rules still apply. Keep preview hosts on the same
site as Hapla for embedded views, or use **在浏览器打开** when browser third-party
cookie restrictions prevent embedding.

Update Web, Server (including database migrations), and CLI together when this
feature is released. Development validation does not authorize production deployment.

## New conversation image and keyboard input

Pasted and selected images share the same decode/compress/thumbnail path before
uploading. Sending is disabled during preparation; rejected images show a visible
error. A first-message upload or delivery failure retains the prompt and images,
and a retry reuses the created session for the same configuration. Repeated Send
clicks do not spawn duplicate sessions.

Software-keyboard Return inserts a newline on phones and touch tablets, including
browsers that report a fine primary pointer. Desktop physical keyboards retain
the Enter-to-send setting and Shift+Enter newline. Composition events and the
trailing IME confirmation Enter do not submit a message. Browser acceptance covers
paste, file selection, a failed upload followed by retry, phone Return, and IME
confirmation in both the new and existing conversation composers.

## Retained ASR implementation

`HAPLA_ASR_URL` configures the authenticated recognition relay. Optional HTTPS
dictation uses `HAPLA_ASR_PAGE_URL` or `EXPO_PUBLIC_ASR_URL`. These settings do not
re-enable the hidden voice controls. See [configuration](configuration.md) and the
[local ASR guide](../integrations/local-asr/README.md).

## Source control workbench

Coder mode's **Changes** opens complete paged diffs, file staging, commits,
branch pushes, draft GitHub pull requests/checks, and Codex turn checkpoints.
Restore coordinates a native conversation fork with files in an exclusive
worktree; it preserves the original branch and rejects stale or shared workspace
state. See [the coding workbench guide](coding-workbench.md) for supported
providers, recovery, GitHub prerequisites, and context-capacity reporting.

## Continuation execution context

Manual `hapla resume` and daemon/Web continuation preserve the stable conversation
root and branch state, so pending queues, BTW records, turn identities and
checkpoints remain associated with the same conversation. Native launch arguments,
profile, sandbox opt-out and provider environment are stored in a private
`runtime-launches` record (directory `0700`, files `0600`). Encrypted session
metadata carries only the opaque reference. Referenced state that has disappeared
causes an explicit failure rather than silently starting with different options.
Standalone resume reads the current `access.key` login first, retaining `agent.key`
compatibility when no current login exists; it never substitutes a stale account.
Manual continuation reads the latest root configuration as well as the current
runtime's native thread identity. Existing sessions predating these records retain
their legacy continuation path; missing historical launch data cannot be recreated.

`session-state.mts` covers fresh-device settings, field synchronization, branch
rejection, durable queue revisions and failed-upload retry with real Codex and a
local Responses fixture. `session-state-native.mts` checks explicit model/effort
reset against the configured native defaults. See the
[acceptance utilities](../scripts/acceptance/README.md).
