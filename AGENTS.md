# Hapla repository guidance

For all Hapla development, iteration, maintenance, deployment, configuration, or environment-isolation work,
use the project skill at [.agents/skills/hapla-maintenance/SKILL.md](.agents/skills/hapla-maintenance/SKILL.md).
It identifies the maintained commands and the boundaries between source, independent
deployments, user workers, and existing private runtime state.

Treat every Hapla change request as development unless the user explicitly requests
“正式部署更新hapla”. Development must use the `dev-hapla` stack, with independent
Web and Server host ports, images, networks, data, and credentials. Run and debug
the Hapla CLI only inside Docker. Preserve running stacks; passing development
checks does not authorize a production update. See [development](docs/development.md).

Keep reusable documentation in `docs/` and installation-specific evidence in ignored
`.runtime/` or `artifacts/`.
Changes to setup and isolation must pass `pnpm test:selfhost`. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) for package-level changes and validation.
