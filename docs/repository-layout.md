# Repository layout

The repository contains Hapla source, tests, and reproducible build inputs.
Cloning it does not copy deployed accounts, conversations, databases, or credentials.

## Source ownership

| Path | Contents |
| --- | --- |
| `packages/hapla-web/` | Web client source in `sources/`, package assets, and colocated tests |
| `packages/hapla-cli/` | Machine daemon and agent adapters in `src/`, launch helpers, Skills, and tests |
| `packages/hapla-server/` | Relay and storage source in `sources/`, Prisma schema/migrations, and tests |
| `packages/hapla-wire/` | Shared schemas and protocol contracts in `src/` |
| `scripts/` | Build/check/release and one-command self-host entry points; deployment tests in `scripts/tests/`, opt-in browser tools in `scripts/acceptance/` |
| `patches/` | Dependency patches applied during installation, with regression checks |
| `deploy/`, `Dockerfile*`, `docker-compose.selfhost.yml` | Application image inputs and deployment templates |
| `integrations/` | Independent optional services and Worker; each owns its setup and dependencies |
| `examples/` | Small integration examples, including an interactive Skill |
| `environments/` | Environment tooling and a source-only agent exercise project |
| `docs/` | Current guides, protocol references, |
| `.agents/skills/hapla-maintenance/` | Project maintenance Skill, linked from root `AGENTS.md` |
| `.github/` | CI, issue forms, and pull-request template |

The four packages are listed explicitly in `pnpm-workspace.yaml` and the root
`package.json` workspace list used by release tooling. They share `pnpm-lock.yaml`.
The gateway's `package-lock.json` and example-specific lockfiles are independent.
Keep dependencies aligned with those installation boundaries.

Existing `src/` and `sources/` package names are retained to preserve imports,
launch paths, and packaging. Put shared wire definitions in `@hapla/wire` rather
than importing another package's internal source. Database migrations remain
inside the Server package; Docker build inputs remain at the repository root.

Application assets and small test fixtures belong in Git. Generated acceptance
media and browser evidence do not. Avoid blanket exclusions for image or media
extensions, which would hide required source assets.

## Local and generated data

- `.runtime/`, `.hapla/`, `.environments/`, `environments/data/`, and Server `data/`:
  credentials, databases, model weights, caches, and deployment state.
- Actual environment files, keys, access passwords, and `wrangler.local.jsonc`:
  commit only sanitized examples.
- `node_modules/`, `dist/`, export staging directories, coverage, browser reports,
  and `.wrangler/`: install/build/test output. Worker runtime types are generated
  into `.wrangler/types/` by the integration's type-check command.
- `artifacts/`: local screenshots, generated media, and acceptance output.

Git-visible source checks honor ignore rules and include newly added source files.
Git is a source backup; back up operational data separately.

## Optional components

See [integrations](../integrations/README.md) and [deployment templates](../deploy/README.md).
The local `integrations/r2-cache/` and `integrations/r2-download/` directories, if
present, are ignored worktrees of an external project. They are not required by
Hapla builds or images. Configure its deployed HTTP service via `HAPLA_R2_CACHE_URL`.

The [optional Codex preparation guide](../scripts/codex-lossless/README.md) describes
pinned upstream patches and acceptance tools. Prepared binaries, credentials,
and machine-specific executable selection stay local; selecting a patched build
requires an explicit `HAPLA_CODEX_PATH`.

Follow [development](development.md) or [deployment](deployment.md) when starting
from a clone. The upstream MIT copyright notices remain in [LICENSE](../LICENSE).
