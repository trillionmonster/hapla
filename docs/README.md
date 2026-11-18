# Hapla documentation

## Start here

- [One-command quick start](quickstart.md): guided configuration and deployment, defaults, and recovery.
- [Environment and account isolation](environment-isolation.md): independent instances and per-user workers, with account-b/account-a examples.
- [Project maintenance Skill](../.agents/skills/hapla-maintenance/SKILL.md): maintained instructions for future code and operations work.

- [Local development](development.md): requirements, installation, and the three development processes.
- [Deployment](deployment.md): standalone builds, Docker self-hosting, and restart behavior.
- [Configuration](configuration.md): server, CLI, Web, ASR, and optional file-service variables.
- [Testing](testing.md): standard checks, pinned Codex schema, and opt-in acceptance.
- [Cloudflare](cloudflare.md): external R2 service, bucket CORS, and experimental Worker configuration.
- [Repository layout](repository-layout.md): source boundaries, integrations, and local data.
- [Contributing](../CONTRIBUTING.md), [security](../SECURITY.md), and [privacy](../PRIVACY.md).

## Behavior and architecture

- [Session lifecycle](session-lifecycle.md): durable history, manual sleep, and resume.
- [Session ordering](session-question-order.md): question timestamps and persistence.
- [Interactive Skills](interactive-skills.md): manifests, MCP Apps, and sandboxed workspace UI.
- [Web interaction features](web-interaction-features.md): attachments, questions, ASR, and page previews.
- [Long sessions and multimodal workspace](multimodal-long-session-design.md): history windowing and media boundaries.
- [Artifact collections](artifact-collections.md) and [video preview/cache](video-preview-and-cache.md).
- [LAN file delivery](lan-file-delivery.md): authenticated originals, mounts, and read-only NAS integration.

## Protocol reference

- [Codex bridge coverage](codex-bridge-coverage.md): App Server requests, notifications, and fallback behavior.
- [Codex CLI updates](codex-cli-update.md): update entry points and model discovery.
- [Protocol journal](codex-protocol-journal.md) and [server error recovery](codex-server-error-recovery.md).
- [Legacy compatibility](legacy-compatibility.md): retained encrypted fields and migration policy.
