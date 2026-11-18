# Hapla CLI

Hapla CLI connects a local Codex or Claude Code process to the Hapla Web workspace through an encrypted session.

## Development

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter hapla build
pnpm cli
```

The default command launches Claude Code. Codex is explicit:

```bash
hapla claude
hapla codex
```

The machine daemon lets Web create sessions while the terminal remains on the local loopback interface:

```bash
hapla daemon start
hapla daemon status
hapla daemon stop
```

Authentication and diagnostics:

```bash
hapla auth login
hapla auth logout
hapla doctor
```

Agent runtimes stay connected until the user explicitly puts them to sleep. Reopen a sleeping conversation from Web to resume it automatically, or run `hapla resume <session-id>` from a terminal. Sleeping does not delete history.

## Environment

- `HAPLA_SERVER_URL`: sync server URL.
- `HAPLA_WEBAPP_URL`: Web client URL.
- `HAPLA_ACCESS_PASSWORD`: optional global site access password for initial login to a password-protected server. Interactive terminals prompt with hidden input when needed; non-interactive login requires this variable and prints a web authorization URL. The password and temporary access cookie stay in memory and are not written to `access.key` or logs. Already authenticated clients keep using their bearer token and do not need this variable. Use the final HTTP(S) server URL; password requests do not follow redirects.
- `HAPLA_HOME_DIR`: state directory; defaults to `~/.hapla`.
- `HAPLA_DISABLE_CAFFEINATE`: disable macOS sleep prevention.
- `HAPLA_EXPERIMENTAL`: enable experimental features.

Hapla does not read `HAPPY_*` environment variables. This prevents another checkout's shell configuration from redirecting Hapla.

Session-specific provider variables such as `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_API_KEY` are configured from Hapla Web and passed to the selected CLI without provider-specific hardcoding.

## Requirements

- Node.js 22 or newer
- pnpm 10.11.0 (the pinned workspace version)
- An installed and authenticated `codex` or `claude` CLI

See the repository [README](../../README.md) and [deployment guide](../../docs/deployment.md).
