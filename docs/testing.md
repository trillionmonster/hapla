# Testing and validation

Run application builds and package tests from the repository root inside a
`dev-hapla` development container, as described in the [development guide](development.md).
Run and debug Hapla CLI only inside Docker, including authenticated acceptance.
Host-side Docker management and documentation/configuration checks that do not
start Hapla are allowed; the self-host tests below use temporary fixtures and
do not start real stacks. Preserve running stacks throughout development.
CI runs the workspace checks and the optional R2 gateway independently. It does
not publish packages, deploy infrastructure, or start authenticated agent turns.
The workspace job explicitly installs system `ripgrep` before running CLI tests;
the checkout does not contain the optional unpacked search binary. A mock version
response does not establish that real searches work. Launcher regression coverage
also verifies discovery of executables available only through `PATH`.
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
and running port owners. This command targets the standard self-host wrapper;
its `--instance` naming does not select the exact `dev-hapla` project. Validate
that project's full verified Compose file list with `config --quiet`, as shown
in the development guide. For a standard self-host configuration check, use the
same `--instance` as the intended target; unrelated workers and stopped rollback
containers do not count as port conflicts.

After an authorized push, check the GitHub Actions run for the exact commit and
wait for its final result. Local checks and a successful push do not establish
that hosted CI passed. Inspect failed job logs, fix the cause, and verify the new
commit's run; historical failed commits retain their original results.

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

For composer and follow-up changes, run the real
[frontend interaction workflows](../scripts/acceptance/README.md#frontend-interaction-acceptance)
inside `dev-hapla`. Close the loop from clicking and typing to native execution,
rendered results, persistence, failure feedback and successful retry. Cover paused
queue isolation, concurrent edits, offline drafts, BTW interruption, terminal
execution, structured questions, live freshness, narrow layouts and proxy access.
Keep actions, results, recordings and failure evidence together in ignored storage.
Do not substitute component mocks or a visual review for these workflows.
