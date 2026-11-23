# Contributing to Hapla

Bug reports, documentation fixes, and focused pull requests are welcome. Read the
[code of conduct](CODE_OF_CONDUCT.md) and [repository layout](docs/repository-layout.md)
before making a change. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Set up a checkout

Use the `dev-hapla` Docker stack for development, with separate Web and Server
host ports and private runtime state. Inside a development container, use Node.js
22+ and the pnpm version pinned in `package.json`, enable Corepack, then run
`pnpm install --frozen-lockfile` from the repository root. Run and debug the Hapla
CLI only inside Docker. See the [development guide](docs/development.md).

Treat Hapla changes as development unless the user explicitly requests
“正式部署更新hapla”. Preserve running stacks throughout development; successful
checks do not authorize a production update.

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

Run `pnpm check` and `pnpm test` inside the dev development container before submitting. For Web export changes, also
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
