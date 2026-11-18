# Hapla repository guidance

For Hapla maintenance, deployment, configuration, or environment-isolation work,
use the project skill at [.agents/skills/hapla-maintenance/SKILL.md](.agents/skills/hapla-maintenance/SKILL.md).
It identifies the maintained commands and the boundaries between source, independent
deployments, user workers, and existing private runtime state.

Keep reusable documentation in `docs/` and installation-specific evidence in ignored
`.runtime/` or `artifacts/`.
Changes to setup and isolation must pass `pnpm test:selfhost`. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) for package-level changes and validation.
