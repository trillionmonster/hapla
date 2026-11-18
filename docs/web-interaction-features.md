# Web interaction features

## Conversation controls

- The composer microphone records directly on trusted HTTPS pages. HTTP pages
  explain the browser restriction and may offer an explicitly configured local
  HTTPS dictation page. Public HTTP pages do not redirect to private-network ASR.
- Attachments show file name, size, and upload state before being sent to the
  session workspace. New-session composition also accepts attachments.
- A single-choice question can be answered by selecting an option. Multiple
  questions or free-text input use explicit submission; resolved requests cannot
  be answered again.
- Codex reply settings are saved per session and apply on the next message.
  Available models, reasoning levels, and Fast support come from the installed CLI.
- The session toolbar can preview workspace HTML, loopback development services,
  or embeddable external pages with desktop/mobile widths.

## ASR

Set `HAPLA_ASR_URL` to the recognition service reachable by the server. The
server relays authenticated audio over the existing Socket.IO `/asr` namespace.
For an optional HTTPS dictation page, use `HAPLA_ASR_PAGE_URL` in self-hosting or
`EXPO_PUBLIC_ASR_URL` in a direct Web build. These values have no default private host.
See [configuration](configuration.md) and the [local ASR guide](../integrations/local-asr/README.md).

The browser checks cross-window origin, window identity, and recording identifiers.
The dictation page receives no Hapla login credentials. AudioWorklet converts
native audio to 16 kHz PCM. Stop, cancel, errors, and navigation release microphone,
audio nodes, and page-owned connections.

## Page preview boundaries

Workspace HTML and loopback Web apps are snapshotted through session RPC, including
scripts, module dependencies, styles, and images. File resources must remain in the
workspace; service resources must share the loopback origin. Resource limits are
4 MiB and 80 resources, with an 8 MiB assembled document limit. Reload the snapshot
to see changes. Complex module graphs may need the browser's direct development-server view.

The preview iframe has an isolated sandbox origin and cannot read Hapla's browser
storage. External websites retain their own embedding restrictions; the UI offers
an external-open action when appropriate.

Update Web, Server, and CLI together for changes to these RPCs. Follow the
[deployment guide](deployment.md); restart local agent daemons after active work
has finished so they load the new build.
