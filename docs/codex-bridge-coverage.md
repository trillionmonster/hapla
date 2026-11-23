# Codex App Server compatibility contract

Audit target: the locally installed Codex CLI App Server schema, regenerated during every `pnpm check:codex-protocol` run. The exact CI version is recorded in [`codexProtocolSnapshot.json`](../packages/hapla-cli/src/codex/codexProtocolSnapshot.json); see [testing](testing.md) before checking a different local CLI version.

Hapla uses the official stdio JSONL App Server transport. Compatibility has two layers: typed first-class handling for every surface that affects a Web conversation, and raw request/notification transport plus lossless unknown-notification forwarding for newly added protocol methods. This avoids the original Happy failure mode where unknown items silently disappeared.

## Contract gates

- Complete `initialize` / `initialized` handshake before any other operation.
- Generate the current CLI schema and enumerate all client requests, client notifications, server requests, server notifications and `UserInput` variants.
- Require first-class current-schema coverage for model discovery, start/resume/read/fork, start/steer turn, Skills and MCP Apps.
- Require an explicit response path for every current server request; unknown requests fail with JSON-RPC `-32601` instead of fake success.
- Preserve unknown notifications as `codex_notification` and unknown item types as generic visible tool envelopes.
- Reject executable use of deprecated `thread/rollback`; root-message edits start an empty sibling thread and preserve the old thread.

## Required interactive Skill path

| App Server surface | Hapla status | Web behavior |
| --- | --- | --- |
| `initialize` capability negotiation | Supported | Experimental App Server APIs enabled; attestation and OpenAI-only form mode are not advertised |
| `model/list` | Supported | Dynamic model and reasoning effort catalog |
| `skills/list`, `skills/config/write`, `skills/changed` | Supported | Catalog, editor, enable switch, interactive badge, forced refresh |
| `UserInput.text`, `image`, `localImage` | Supported | Normal and multimodal turns |
| `UserInput.skill`, `mention` | Supported in wire types | Interactive submission uses explicit `skill`; mentions are preserved for future composer UI |
| `item/mcpToolCall` | Supported | Tool card plus lazy MCP App surface when `appContext.resourceUri` exists |
| `mcpServer/resource/read` | Supported | Reads `ui://` HTML through encrypted session RPC |
| `mcpServer/tool/call` | Supported | Implements iframe `tools/call` with scope, size, rate, and concurrency checks |
| MCP Apps `ui/initialize` | Supported | Negotiates protocol and host capabilities |
| Tool input and result notifications | Supported | Hydrates the iframe from the Codex item and subsequent tool calls |
| `ui/message` | Supported | Queues a text follow-up in the main Codex conversation |
| `ui/update-model-context` | Supported | Holds bounded ephemeral context until submission |
| Explicit Skill hand-off | Supported Hapla extension | `hapla/submit` queues text, selected images, and an enabled `skill` input item |
| Generated image item and path mentions | Supported | Uploads and renders in the main conversation, not the iframe card |
| `thread/fork` and branch switching | Supported | A persisted sibling thread is created and the selected thread is resumed before future turns |
| Unknown future notifications | Lossless fallback | Forwarded with method and params instead of being dropped |

## Follow-up controls

`turn/steer` targets the expected active turn without canceling it. Independent
queued inputs are durable and editable in Hapla. BTW uses its own App Server
connection and a forked thread, with copied goals cleared before its read-only
turn; side cancellation is scoped independently of main permissions and turns.
Explicit stop and stop-and-send validate the captured runtime identity. See the
[Web interaction guide](web-interaction-features.md) for the controls, queue
recovery behavior, commands, and branch semantics.

## Server requests

| Request | Status | Notes |
| --- | --- | --- |
| Command execution approval | Supported | Web permission state returns v2 decision values |
| File change approval | Supported | Uses item changes captured from App Server |
| `item/tool/requestUserInput` | Supported | Option, free-form, secret, and multi-answer UI; returns official answer map |
| MCP `form` elicitation | Supported | Primitive strings, numbers, booleans, single and multi enums are converted back to structured content |
| MCP URL elicitation | Approval fallback | URL and message are shown as a permission request; Hapla does not navigate automatically |
| `item/permissions/requestApproval` | Supported | Returns only the requested network or filesystem subset and selected turn/session scope |
| `item/tool/call` dynamic tools | Explicitly unavailable | Hapla advertises no client dynamic tools and returns `success:false` if Codex calls one |
| Unknown request | Safe error | Returns JSON-RPC `-32601`, never a fake successful `{}` |

## Thread items

| Item | Status |
| --- | --- |
| User and agent messages | First-class |
| Command execution and file change | First-class tool cards |
| MCP tool call | First-class tool card and optional app surface |
| Image generation | First-class generated media path |
| Plan and reasoning | Thinking text through provider events or completed v2 items |
| Dynamic tool call | Generic tool card; execution is rejected because Hapla advertises none |
| Collaboration and subagent activity | Existing subagent envelopes plus a generic v2 tool-card fallback |
| Web search, image view, sleep | Generic v2 tool-card fallback |
| Review mode and compaction | Service events |

Previously, every unknown `item/*` notification returned early and disappeared. The App Server client now emits a `codex_item` fallback, and the session mapper turns completed text items, service transitions, and remaining tool-like items into Web-visible envelopes.

## Deliberately unadvertised optional capabilities

- iOS native MCP App container
- Codex realtime voice items
- ChatGPT connector OAuth and account token refresh UI
- Client-provided experimental dynamic tools
- Remote marketplace plugin install and uninstall
- Attestation generation

These surfaces are not advertised in `initialize`, so App Server must not depend on them. Unknown server requests fail closed and never receive a fabricated success response.

## Version maintenance

The checked-in types are a deliberate subset of generated Codex types. On each Codex CLI upgrade:

```bash
pnpm check:codex-protocol
```

The checker creates an isolated temporary schema with `codex app-server generate-ts --experimental`, compares it with the executable bridge, and deletes it afterward. Add a regression fixture before accepting a new request or item discriminator.
