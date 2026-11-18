# Repository tooling

Run tooling from the repository root. Prefer the public pnpm scripts in
[`package.json`](../package.json) when available.

| Tooling | Purpose |
| --- | --- |
| `postinstall.cjs`, `../patches/` | Deterministic dependency fixes and shared wire build |
| `check-*.cjs` | Documentation, source isolation, protocol compatibility, and bundle checks |
| `export-web.cjs`, `serve-web.cjs` | Atomic static exports and SPA-aware serving |
| `selfhost.cjs`, `lib/selfhost.cjs` | Shared one-command configuration, deployment, health, and worker lifecycle implementation |
| `selfhost-*.cjs` | Compatibility wrappers for preflight and Compose validation |
| `tests/selfhost.test.cjs` | Setup, secret retention, port, fake-Docker lifecycle, and real Compose isolation checks |
| `worker-image-smoke.cjs` | Exercise an actual CLI image offline: entry points, non-root paths, and native PTY |
| `hash-site-access-password.cjs` | Generate an entry-password hash from private stdin |
| `release.cjs` | Interactive or explicit selection of a publishable workspace package |
| `generate-brand-assets.cjs` | Application brand asset generation |
| `lib/` | Shared configuration, instance isolation, and repository-file discovery |
| `acceptance/` | Opt-in browser, session-cache, media, and real-deployment acceptance utilities |
| `codex-lossless/` | Optional pinned upstream Codex patches and preparation scripts |

Source checks inspect Git-visible files, including new untracked source files,
and honor ignore rules for local data. Archived reports are excluded from the
current product-isolation and documentation-link gates.

See [testing](../docs/testing.md), [browser acceptance](acceptance/README.md), and
the [optional Codex build guide](codex-lossless/README.md) for prerequisites.
