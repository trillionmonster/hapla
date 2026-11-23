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
- Codex reply settings apply to the next message. Model, reasoning, and Fast
  options come from the installed CLI.
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
- On short mobile viewports the BTW panel compacts its controls and hides its
  picker when necessary, keeping the main composer and stop/close actions usable.
  With very little remaining height it becomes a header with reachable stop and
  close controls. Low-height touch layouts also condense the branch bar so its
  headings do not overlap the composer toolbar.
- Voice input is temporarily hidden in both existing and new conversations by
  `VOICE_INPUT_ENABLED` in the Web feature flags. Its implementation remains available.

## Persistent development page proxy

In a conversation on the workbench that can reach your service, choose **预览**
in the workspace toolbar, enter the full service address (for example
`http://127.0.0.1:5173/`), and click **注册并打开**. Use **在浏览器打开** to
open or save the generated URL. To change the service address, select its
existing registration and click **更新目标并打开**; keep the original link.
`localhost` refers to the selected workbench's host or container, rather than
the computer running the browser. A service on another computer must be
reachable from that workbench.

The preview panel registers an HTTP(S) target reachable from the selected
workbench. It returns `/preview/<handle>/`, resolved against the browser's actual
Hapla origin, including its current port. Agents can also use the Hapla MCP tools
`register_web_preview` and `list_web_previews`; return their relative URL as a
Markdown link. Reusing a workbench/name or updating a selected handle changes the
target while preserving the URL. Registration is stored in the relay database.
Codex's STDIO MCP bridge discovers and forwards the HTTP server's registered
tools, including both preview tools, with their original schemas and results.
Tool discovery and invocation must be checked through the STDIO transport;
testing only the HTTP server does not establish availability to Codex.

Only the authenticated account owning the registration can open it. The browser
receives an HttpOnly, SameSite preview cookie after login verification; logout or
account switching clears it. Every request and WebSocket handshake rechecks
account ownership. Hapla authorization headers and cookies are stripped before
upstream forwarding. Each target must belong to an owned workbench.

The daemon tunnels live HTTP, POST bodies, binary data, SSE, and WebSockets.
HTML receives a small routing bridge for root-relative fetch, modules, styles,
and HMR; Web serving layers redirect root resources using the preview referrer.
Simultaneous tabs keep separate handles. Upstream restart, a new target address,
or relay restart does not change the handle; requests resume once the target and
workbench reconnect. Offline requests show a retryable error.
Additional reverse proxies and port mappings use the browser's external origin;
forwarding layers must carry HTTP and WebSocket traffic to Hapla, including
`/preview/`. The target service does not need its own public listening port.
Nginx emits relative redirects (`absolute_redirect off`) so a root-level link,
form submission, or directory redirect retains the browser's external scheme
and port. Browser acceptance must exercise a real Nginx hop behind an external
HTTP and HTTPS port, including login navigation, form POST, response cookies,
and the post-login redirect; a Node development server alone misses this case.

The workbench must remain connected and able to reach the target. External
websites retain their own embedding and CSP restrictions. Workspace HTML file
previews retain the isolated snapshot sandbox and file-resource limits described
by the existing workspace preview implementation. Registered live development
apps run under the selected Hapla browser origin.

Update Web, Server (including database migrations), and CLI together when this
feature is released. Development validation does not authorize production deployment.

## Retained ASR implementation

`HAPLA_ASR_URL` configures the authenticated recognition relay. Optional HTTPS
dictation uses `HAPLA_ASR_PAGE_URL` or `EXPO_PUBLIC_ASR_URL`. These settings do not
re-enable the hidden voice controls. See [configuration](configuration.md) and the
[local ASR guide](../integrations/local-asr/README.md).
