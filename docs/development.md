# Development in dev-hapla

All Hapla development and iteration uses the `dev-hapla` Docker stack. Treat a
change request as development unless the user explicitly requests
“正式部署更新hapla”. Reproducing a live issue, completing tests, or asking to
“update Hapla” does not authorize a production update. See the
[maintenance skill](../.agents/skills/hapla-maintenance/SKILL.md) for the full workflow.

## Identify the development stack

Inspect the working tree, running containers, published ports, host listeners,
Compose project labels, and actual mounts before changing runtime configuration:

```bash
git status --short
docker compose ls
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'
docker ps -a --filter label=com.docker.compose.project=dev-hapla
ss -ltn
```

Record the verified dev configuration paths and the live container IDs, start
times, image IDs, and ports in ignored `.runtime/dev-hapla/` or `artifacts/`.
Inspect only necessary fields; do not print credentials or full container environments.
If live services bind-mount the source or build outputs being changed, use a
separate development checkout/worktree before editing those paths.

The Docker project name must be exactly `dev-hapla`. Other `dev-*` projects have
their own owners and are not substitutes. The one-click wrapper prefixes named
instances with `hapla-`: `./deploy.sh --instance dev-hapla` selects
`hapla-dev-hapla`, so it does not select this development stack.

If `dev-hapla` does not exist and runtime validation is needed, prepare its own
Compose configuration and resources. The repository currently supplies reusable
Server/Web and worker templates, rather than a dedicated dev stack template.
Use [`docker-compose.selfhost.yml`](../docker-compose.selfhost.yml),
[`deploy/compose.worker.yml`](../deploy/compose.worker.yml), and the corresponding
Dockerfiles as inputs; retain the isolation requirements below. Keep local paths,
chosen ports, and secrets in ignored private configuration. Documentation-only
changes do not require creating or starting a stack.

## Isolate all runtime resources

| Resource | Development requirement |
| --- | --- |
| Web host port | An explicitly chosen free port, separate from live ports and the dev Server port; bind to `127.0.0.1` by default |
| Server host port | Its own explicitly chosen free port; publish it separately even when Web proxies API requests |
| Container ports | The static Web image may keep port 80 and Server port 3005 on the dev network |
| Images | Dev-only tags, such as `hapla-web:dev-hapla`, `hapla-server:dev-hapla`, and `hapla-worker:dev-hapla` |
| Network and database | Dev-owned network, data volume, and persistent master secret; one Server writer per PGlite directory |
| CLI state | Dev-only home, Hapla pairing, agent credentials, and workspace volumes |
| Source and dependencies | Current dev source, container-owned dependencies and build outputs; no writes to live bind mounts |

Check both Docker port publications and host listeners. If a proposed dev port
is occupied by another service, choose a different dev port. Do not stop or
reconfigure the existing service to make room. Reusing container port 3005 on a
separate network is allowed; reusing a live host binding is not.

Use only dev data and credentials. Do not mount live databases, workspaces, or
host/other-user `.hapla`, `.codex`, or `.claude` directories. Do not attach the
dev CLI to the live relay network or mount the Docker socket into it.

Set `HAPLA_SERVER_URL=http://server:3005` inside the CLI container and set
`HAPLA_WEBAPP_URL` to the actual dev browser entry. The CLI defaults to
`http://127.0.0.1:12345` if not configured. In a container, loopback refers to
that container. Browser API requests must use the dev public Server address or
the dev Web same-origin proxy; browsers cannot resolve Docker's `server` name.

## Build and debug inside Docker

Install application dependencies, build, run package tests, authenticate, and
debug Hapla CLI inside dev containers. Do not install/link Hapla or run
`pnpm cli`, `hapla`, or a test daemon on the host. Host-side editing, Docker
management, and documentation/configuration checks that do not start Hapla are
allowed. If Docker is unavailable, finish static work and report runtime checks
as blocked; keep the CLI in Docker.

For source development, prepare a dev container with Node.js 22+, pnpm 10.11.0,
the current checkout, development dependencies, and a compiler toolchain for
native PTY dependencies. [`deploy/Dockerfile.worker`](../deploy/Dockerfile.worker)
is a runtime image; its final stage does not provide a complete pnpm development
environment. A rebuilt worker image can validate packaged CLI behavior; source
tests require the development environment.

For an existing verified Compose deployment, a Bash helper can keep every action
scoped to the dev project. The paths below are placeholders: use the actual
private env file and **all** Compose files, in their original order.

```bash
DEV_ENV_FILE=/absolute/path/to/private/dev.env
DEV_COMPOSE_FILES=(/absolute/path/to/dev/compose.yml /absolute/path/to/dev/override.yml)
dev_compose() {
  local dev_compose_args=()
  local dev_compose_file
  for dev_compose_file in "${DEV_COMPOSE_FILES[@]}"; do
    dev_compose_args+=(-f "$dev_compose_file")
  done
  docker compose --project-name dev-hapla --env-file "$DEV_ENV_FILE" "${dev_compose_args[@]}" "$@"
}
dev_compose config --quiet
dev_compose ps -a
```

After verifying resource ownership and isolation, build and start only the dev
services needed for the task. The following examples assume a dev service named
`cli`, with source and development tooling at `/repo`, and the dev URLs configured
in its container environment. Use `run --rm` when that service is not running.

```bash
dev_compose exec -w /repo cli corepack enable
dev_compose exec -w /repo cli pnpm install --frozen-lockfile
dev_compose exec -w /repo cli pnpm build
dev_compose exec -w /repo cli pnpm cli auth login
dev_compose exec -w /repo cli pnpm cli codex
# Or: dev_compose exec -w /repo cli pnpm cli claude
```

The install script applies checked-in dependency fixes from `patches/` and builds
the wire package; keep install scripts enabled. Pair only the dev account and
authenticate agents inside its container. Unit tests need no agent credentials.
Rebuild the dev image or load current dev source before testing a change; an old
installed CLI does not validate modified source.

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build wire and CLI, then type-check Server and Web |
| `pnpm web:build` | Export static Web assets and check bundle boundaries |
| `pnpm check` | Check current documentation links, architecture, Codex protocol, and builds |
| `pnpm test` | Dependency-patch, wire, CLI unit, Server, and Web tests |
| `pnpm selfhost:check` | Validate the standard self-host wrapper and Compose graph; it does not select `dev-hapla` |

Run package commands above inside the dev development container. Docker-level
checks can run from the host without granting the CLI container a Docker socket.
For the custom dev graph, use the verified `dev_compose config --quiet` command.
See [testing](testing.md) for the pinned Codex version and
[configuration](configuration.md) for environment variables.

After runtime validation, check dev Web, Server `/health`, container CLI behavior,
and the changed feature with a dev account. Compare live container IDs, start
times, image IDs, and ports with the earlier record. Report the actual dev ports
and checks performed. Leave production updates for an explicit
“正式部署更新hapla” request.
