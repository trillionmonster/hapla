# Testing and validation

Run commands from the repository root unless another directory is specified.
CI runs the workspace checks and the optional R2 gateway independently. It does
not publish packages, deploy infrastructure, or start authenticated agent turns.
An additional worker-image job builds the optional CLI image and checks its Hapla
and Codex entry points, non-root writable paths, and native PTY with networking
disabled and no account credentials. To repeat after building an image, run
`node scripts/worker-image-smoke.cjs YOUR_WORKER_IMAGE`.

## Standard checks

```bash
pnpm check
pnpm test
pnpm web:build
pnpm selfhost:check
```

`pnpm check` verifies current Markdown file links, package/provider boundaries,
the frozen Codex App Server schema, and builds/type checks all four packages.
`pnpm test` covers self-host automation, dependency patches, wire contracts, CLI unit tests,
Server, and Web. `pnpm selfhost:check` needs Docker Compose; it validates configuration
without starting containers. Docker must be running so the preflight can check project ownership
and running port owners. Use the same `--instance` as the target installation; unrelated workers
and stopped rollback containers do not count as port conflicts.

## Codex protocol version

The exact CLI version is recorded in
[`codexProtocolSnapshot.json`](../packages/hapla-cli/src/codex/codexProtocolSnapshot.json).
CI installs that version before running the schema check. To inspect it:

```bash
node -p "require('./packages/hapla-cli/src/codex/codexProtocolSnapshot.json').cliVersion"
pnpm check:codex-protocol
```

A newer locally installed Codex can fail the check even when the application
builds. Use the pinned version in an isolated test environment, or review a protocol
upgrade as a separate change. Do not regenerate the snapshot just to silence a
version mismatch. The protocol check does not require login or a model request.

## Focused checks

| Command | Coverage |
| --- | --- |
| `pnpm test:selfhost` | Configuration lifecycle, key retention, credential isolation, fake-Docker deployment, and actual Compose rendering; starts no real containers |
| `pnpm check:docs` | Relative file links in current Markdown documentation; archived reports are excluded |
| `pnpm check:boundaries` | Supported providers, compatibility naming, and lightweight deployment structure |
| `pnpm --filter @hapla/wire test` | Shared contracts |
| `pnpm --filter hapla test` | CLI build and unit project |
| `pnpm --filter hapla-server test` | Server unit and component tests |
| `pnpm --filter hapla-web test --run` | Web unit tests |

For the independent Worker, use Node.js 22+ and Python 3.10+:

```bash
cd integrations/r2-download-gateway
npm ci
npm test
npm run typecheck
npm run build
```

Gateway type checking generates runtime types in ignored `.wrangler/types/`.
The build is a Wrangler dry run and does not require deployment credentials.
Unit tests cover signed-link boundaries and streaming; Python tests cover portable
configuration generation and rejection of invalid inputs without copying credentials.

## Real agents and browsers

`pnpm --filter hapla test:integration` runs real Claude/Codex and daemon acceptance
projects. These require installed CLIs and the applicable isolated authentication
setup. They can consume provider quota. See the CLI's [agent acceptance rules](../packages/hapla-cli/agents.md).

Browser and media acceptance utilities live in
[`scripts/acceptance/`](../scripts/acceptance/README.md). Set `CHROMIUM_PATH` or install
`chromium` on `PATH`; no developer-specific browser installation is assumed.
Production-oriented utilities may create sessions or messages and require explicit
test account inputs. Inspect the script and use an isolated deployment.
