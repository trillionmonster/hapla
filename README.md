# Hapla

Hapla is a Web-first workspace for Claude Code and Codex. A local CLI connects
agents and workspace files to a browser through an encrypted synchronization server.

- Run Claude Code or Codex sessions with models and reasoning options from the installed CLI.
- Use Normal mode for conversations, or Coder mode for tool output, a persistent terminal, and file browsing.
- Preview images, video, audio, PDFs, and workspace pages with lazy-loaded media controls.
- Manage user and project Skills, including optional sandboxed interactive Skill pages.
- Keep durable conversation history and explicitly sleep or resume agent runtimes.
- Self-host with one embedded-database server and one static Web container.

## Quick start: one-command deployment

Install Node.js 22+ and Docker with Compose v2, clone the repository, then run:

```bash
./deploy.sh
```

Press Enter for the local defaults. The wizard generates a private master secret,
finds an available port, builds the two images, starts the stack, and waits for
its health endpoint. No pnpm or application dependency installation is needed on the host.
Rerunning preserves the existing key and data.

```bash
./deploy.sh up --non-interactive      # defaults without prompts
./deploy.sh up --instance staging     # a separate full environment
./deploy.sh status
./deploy.sh logs
./deploy.sh down                      # keep persistent data
```

See the [step-by-step quick start](docs/quickstart.md) for LAN access, passwords,
ASR, file delivery, and per-user workers. [Environment isolation](docs/environment-isolation.md)
explains separate deployment instances and per-user worker layouts.
Agent account login is performed separately by each user.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Follow [local development](docs/development.md) to start the server, Web client,
and CLI in separate terminals. It uses embedded PGlite and requires no external database.
See [testing](docs/testing.md) for checks and the exact Codex protocol version used by CI.

## Repository

| Path | Purpose |
| --- | --- |
| `packages/hapla-web` | Expo Router Web client |
| `packages/hapla-cli` | Local Claude Code/Codex wrapper and daemon |
| `packages/hapla-server` | Encrypted sync, file delivery, and RPC server |
| `packages/hapla-wire` | Shared wire contracts |
| `deploy/` | Deployment templates and optional Cloudflare configuration |
| `integrations/` | Independent optional ASR and download-gateway integrations |
| `scripts/` | Build, validation, release, and opt-in acceptance tooling |
| `examples/`, `environments/` | Integration examples and development fixtures |
| `docs/` | Current guides and reference material |
| `.agents/skills/hapla-maintenance/` | Repository maintenance, deployment, and isolation Skill |

See [repository layout](docs/repository-layout.md) for ownership and generated-data boundaries.

## Documentation and contribution

Use the project [maintenance Skill](.agents/skills/hapla-maintenance/SKILL.md) for future maintenance.
Start with the [documentation index](docs/README.md), [configuration reference](docs/configuration.md),
and [Cloudflare guide](docs/cloudflare.md). Cloudflare R2 and the experimental download
Worker are optional; they are not required by the default two-container deployment.

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities through [SECURITY.md](SECURITY.md). The [privacy description](PRIVACY.md)
explains the separate trust boundaries for encrypted conversations, file delivery, and agent providers.

Some historical encrypted fields and migration keys retain the `happy` prefix for
existing records. New commands and APIs use Hapla; see [compatibility](docs/legacy-compatibility.md).

## License

Hapla is derived from the open-source Happy project and retains its MIT license
and upstream copyright notices. See [LICENSE](LICENSE).
