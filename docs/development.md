# Local development

Use Node.js 22+ and pnpm 10.11.0, as pinned in `.nvmrc` and `package.json`.
Linux and macOS are the primary CLI development environments; native PTY and
sandbox dependencies may need a compiler toolchain. Install and authenticate
`claude` or `codex` to run real agent sessions. Unit tests do not need agent credentials.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The install script applies the checked-in dependency fixes in `patches/` and builds
the shared wire package. Do not disable install scripts for a normal development checkout.

## Start the three processes

Run each command from the repository root in a separate terminal. First, start
the server with a private master secret. Generate a value with `openssl rand -hex 32`
and keep the same value across restarts of the same database.

```bash
export HAPLA_MASTER_SECRET=replace-with-your-generated-secret
pnpm server
```

`pnpm server` starts the standalone PGlite server on port 3005, applies migrations,
and stores local data under `packages/hapla-server/data/` (ignored by Git).
It does not require a separate PostgreSQL server.

Start Expo Web with the relay URL explicitly configured:

```bash
EXPO_PUBLIC_HAPLA_SERVER_URL=http://127.0.0.1:3005 pnpm web
```

Open the address printed by Expo (normally `http://localhost:8081`). Connect the
local CLI to the same relay and Web entry:

```bash
export HAPLA_SERVER_URL=http://127.0.0.1:3005
export HAPLA_WEBAPP_URL=http://localhost:8081
pnpm cli auth login
pnpm cli codex
# Or: pnpm cli claude
```

Use the actual Expo port if 8081 is occupied. Without these explicit CLI variables,
the CLI targets the self-hosted entry at `http://127.0.0.1:12345`.

## Isolated environments

The `pnpm env:*` commands manage local fixtures and process state. Run
`pnpm env:list` to inspect environments and `pnpm exec tsx environments/environments.ts --help`
for available commands. `pnpm env:new --no-switch` creates a fixture without changing the active environment.
Generated environment data stays in ignored directories. The small source fixture
in `environments/lab-rat-todo-project/` can be copied for real agent acceptance tests.

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build wire and CLI, then type-check Server and Web |
| `pnpm web:build` | Export static Web assets and check bundle boundaries |
| `pnpm check` | Check current documentation links, architecture, Codex protocol, and builds |
| `pnpm test` | Dependency-patch, wire, CLI unit, Server, and Web tests |
| `pnpm selfhost:check` | Validate source isolation and the Docker Compose graph |

See [testing](testing.md) for the Codex version required by protocol checks and
[configuration](configuration.md) for server, CLI, and build-time variables.
