# Prepared Codex App Server for Hapla

The current `codex` and `codex-0.156.1` launchers use an isolated build of the
official Codex `rust-v0.156.1` source at commit
`b412ff32c417f855c2b2d1581b77058eed87c84b`.
Source: https://github.com/openai/codex/tree/b412ff32c417f855c2b2d1581b77058eed87c84b

The older `build.sh` and 0.153.4 patches are retained for historical reproduction.
That script builds 0.153.4, not the binary required by the current launchers. Use
the versioned preparation command below for a fresh checkout.

The upstream native command stream subscribed to a broadcast channel after the
process had already produced its first output. It also ignored overwritten
broadcast chunks, stopped forwarding after 10,000 deltas, and allowed a 100 ms
post-exit deadline to truncate pending output. The model's tool result could
therefore contain text missing from App Server's command item and deltas.

The patch reserves the sole streaming receiver before output begins, merges
local stdout/stderr through bounded channels with backpressure, waits for output
EOF, and waits for delivery before ending short commands. Each emitted delta
remains at most 8 KiB; there is no total-delta cutoff. The bounded native transcript
is unchanged. Hapla retains a bounded preview and writes received full output to
its command log.

## Prepare once before starting a new runtime

From the repository root, on Linux with Git, Node.js and rustup installed:

```sh
./scripts/codex-lossless/build-0.156.1.sh
```

The script downloads the pinned source and Rust 1.95.0, applies the checked-in
patches, and builds into `.runtime/codex-source-0.156.1-lossless/`. It uses the
matching official 0.156.1 code-mode helper or builds that helper from the same
source. To reuse a matching isolated npm installation for the helper, set
`HAPLA_CODEX_OFFICIAL_CLI` to its `codex` launcher. Preparation writes
`.runtime/codex-lossless-0.156.1.manifest.json` with SHA-256 digests of the wrapper,
App Server, and tool host.

Preparation leaves the current `codex` wrapper, any existing
`.runtime/codex-lossless.manifest.json`, older source/build directories, and running
processes intact. After validating the versioned manifest and streaming regressions,
select the prepared executable explicitly in the environment used to start Hapla:

```sh
export HAPLA_CODEX_PATH="$PWD/scripts/codex-lossless/codex-0.156.1"
"$HAPLA_CODEX_PATH" --version
pnpm --filter hapla cli -- codex
```

This requires the normal Hapla dependencies/build and an existing Codex login.
For daemon-managed sessions, set the same absolute path in the daemon's startup
environment. Changing a shell variable does not update an already running daemon.
Existing agent processes continue with the executable they started with.

Local `.hapla/codex-app-server.json` selection and `.runtime/` manifests are not
included in Git. A fresh clone does not automatically select a prepared App
Server; use the explicit override above. The launcher's version check rejects a
stale or missing binary. Installations using the optional local manifest-selection
configuration also validate its digests; if deployment changes the wrapper path or
contents, regenerate that manifest before selecting it.

The global Codex installation is not changed. The launcher supports App Server
and version probing; it is not a replacement for the interactive Codex CLI.

## Verify against the real provider

```sh
node scripts/codex-lossless/verify-output.mjs
node scripts/codex-lossless/verify-output.mjs --large
pnpm exec tsx scripts/codex-lossless/verify-output.mjs --boundary
```

The scripts start independent App Server processes with the existing Codex login,
run exactly one test command per new thread, and compare native streamed bytes
against an independently calculated SHA-256 digest. They record command metadata
and hashes, not credentials or reasoning. Raw received logs are written beneath
`.runtime/evidence/codex-lossless/`.

The 10 MiB case produces 10,485,801 bytes including its first/last markers and
expects SHA-256
`420f2621f5f4a13fc94ad6c0121ffab6ac907cb7ba0fd03f11fa4d26c9a71120`.
The startup case checks the first line, Chinese stderr and final line.
Each invocation prints its JSON report to stdout. Historical reports under
`artifacts/reliability-p0/verify-lossless-*.json` are local acceptance evidence and
are excluded from Git.

The boundary case produces exactly 1 MiB + 1 byte. Codex's capped aggregate is
larger than the original output because its omission marker adds bytes. This
case feeds the real native events through Hapla's actual command log store and
checks the retained log's SHA-256. Runtime reconciliation verifies all received
bytes before accepting a longer aggregate; byte count alone cannot prove that
an aggregate is complete.

The patch also contains upstream Rust regressions for output produced before
subscription, a slow consumer receiving a 10 MiB burst, output arriving after
process exit, UTF-8 boundaries, and more than 10,000 deltas. Run them using the
same isolated Cargo home and pinned toolchain:

```sh
cd /tmp
CARGO_HOME=/path/to/hapla/.runtime/cargo-lossless cargo +1.95.0 test --locked \
  --manifest-path /path/to/hapla/.runtime/codex-source-0.156.1-lossless/codex-rs/Cargo.toml \
  -p codex-utils-pty lossless_combined_output
CARGO_HOME=/path/to/hapla/.runtime/cargo-lossless cargo +1.95.0 test --locked \
  --manifest-path /path/to/hapla/.runtime/codex-source-0.156.1-lossless/codex-rs/Cargo.toml \
  -p codex-core --lib streaming_output_
```

The verified execution path is local UTF-8 command output. Remote exec-server
transport replay retains its upstream retention semantics and needs separate
transport-specific acceptance before being described as lossless.
