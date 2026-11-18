# Hapla interactive Skills

An interactive Skill is a product concept built from standard Codex and MCP primitives. It is not a new replacement for `SKILL.md`.

## Contract

An interactive Skill contains three independent layers:

1. `SKILL.md` explains when Codex should use the workflow and how to interpret its result.
2. An MCP server exposes ordinary data and action tools plus an MCP Apps HTML resource using `text/html;profile=mcp-app`.
3. `.hapla/interactive.json` tells Hapla how to start that MCP server for an enabled Skill.

The MCP tools must remain useful without the HTML resource. Codex can therefore complete the workflow in clients that do not render MCP Apps.

The UI resource and bridge follow the [OpenAI MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui) and [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart). Hapla uses the [Codex App Server](https://learn.chatgpt.com/docs/app-server) to read resources and call tools instead of inventing a second tool protocol.

## Manifest

Place this next to an enabled `SKILL.md`:

```json
{
  "schemaVersion": 1,
  "id": "character-composer",
  "displayName": "Character composer",
  "mcpServer": {
    "command": "node",
    "args": ["./server.mjs"],
    "envFromHost": ["CHARACTER_ASSET_BASE_URL"]
  }
}
```

Relative executable and argument paths resolve from the Skill directory. Environment values are never stored in the manifest. Only names in `envFromHost` are copied from the Hapla CLI process.

Hapla loads manifests only for Skills that the installed Codex CLI reports as enabled. Invalid manifests and duplicate ids are skipped with an explicit CLI warning.

## Runtime flow

```text
Codex calls render tool
  -> item/mcpToolCall carries appContext.resourceUri
  -> Hapla CLI sends the MCP call into the encrypted session stream
  -> Hapla Web reads ui:// resource through session RPC
  -> sandboxed iframe initializes the MCP Apps postMessage bridge
  -> user explores and submits structured intent
  -> tools/call returns through Web -> CLI -> Codex App Server -> MCP server
  -> hapla/submit queues a new Codex turn with text, image inputs, and optional Skill input
  -> Codex runs the hand-off Skill
  -> normal Codex items and generated media render in the Hapla main conversation
```

The embedded page is an isolated micro-application. Its state is not Hapla application state. `ui/update-model-context` sends only the current model-visible selection. The server remains authoritative for durable data.

## Supported iframe methods

- `ui/initialize`
- `ui/notifications/initialized`
- `ui/notifications/tool-input`
- `ui/notifications/tool-result`
- `tools/call`
- `ui/message`
- `ui/update-model-context`
- `hapla/submit`, a Hapla extension for text, image references, and an explicit hand-off Skill

Use `ui/message` for portable text follow-ups. Use `hapla/submit` only when the UI must attach selected image references or request an explicit Skill hand-off. A page should offer a useful text-only fallback.

## Security boundary

- The iframe uses `sandbox="allow-scripts allow-forms"`. It does not receive same-origin, top-navigation, popup, filesystem, terminal, or shell access.
- Hapla injects a CSP derived from `_meta.ui.csp`. Nested frames and network connections are blocked unless declared.
- Every `postMessage` is checked against the exact iframe window.
- Resource reads and tool calls are scoped to an MCP server and `resourceUri` observed in the active Codex session.
- Tool arguments are limited to 256 KiB, resources to 2 MiB, and each surface to 30 calls per minute with four calls in parallel.
- Structured submission supports at most 12 HTTPS or small image data URLs. Local paths from iframe code are rejected.
- Hand-off Skill names are resolved against Codex's enabled Skill catalog. An ambiguous name requires its exact `SKILL.md` path.
- Unknown Codex server requests fail explicitly. Hapla no longer returns a fake successful empty object.

## Performance contract

Opening an interactive surface lazy-loads its host code. Closing it removes the iframe and releases its document. Skill pages should virtualize large catalogs, keep only visible media in the DOM, preload only likely adjacent choices, and release temporary preloads. The character composer example implements this pattern for five groups of 40 references.

See [the character composer example](../examples/interactive-skills/character-composer/README.md).
