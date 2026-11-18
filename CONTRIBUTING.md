# Contributing to Hapla

Bug reports, documentation fixes, and focused pull requests are welcome. Read the
[code of conduct](CODE_OF_CONDUCT.md) and [repository layout](docs/repository-layout.md)
before making a change. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Set up a checkout

Use Node.js 22+ and the pnpm version pinned in `package.json`. Enable Corepack,
then run `pnpm install --frozen-lockfile` from the repository root. See the
[development guide](docs/development.md) for starting the embedded database,
Web client, and local CLI without external infrastructure.

The four application packages share the root `pnpm-lock.yaml`. Optional
integrations and examples have their own installation instructions and lockfiles;
they are not part of the pnpm workspace.

## Make a change

- Keep changes within the relevant package. Put shared protocol contracts in
  `packages/hapla-wire`; application UI and runtime behavior belong in their own packages.
- Follow the surrounding code's style. Keep tests beside the behavior they cover.
  Add regression coverage for behavior changes; documentation-only edits do not need new tests.
- Preserve encrypted wire identifiers and migration compatibility. See the
  [compatibility policy](docs/legacy-compatibility.md).
- Update current documentation and configuration examples with behavior changes.
  Keep installation-specific investigations and deployment evidence in ignored local storage.
- Use placeholders in examples. Keep credentials, signed URLs, account data,
  generated media, and deployment state out of commits.
- Commit dependency changes with the relevant lockfile. Do not switch package
  managers or reformat unrelated files.

## Validate

Run `pnpm check` and `pnpm test` before submitting. For Web export changes, also
run `pnpm web:build`; for deployment templates, run `pnpm selfhost:check`.
The [testing guide](docs/testing.md) explains the pinned Codex requirement,
package-level commands, optional gateway checks, and authenticated integration tests.

Do not run acceptance scripts against another person's deployment. Use an isolated
test account and workspace; some scripts create messages or call paid agent services.

## Open a pull request

Describe the problem, the resulting behavior, and how you validated it. Link any
relevant issue and include screenshots when they help explain a UI change.
Keep each pull request focused and note checks you could not run with their reason.
Maintainers review releases manually; opening a pull request does not publish or deploy it.
