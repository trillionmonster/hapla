# Opt-in acceptance utilities

These scripts are separate from the unit-test suite. Run them from the repository
root and inspect each script's inputs before use. Use an isolated deployment,
test account, and workspace: production-oriented scripts can create conversations,
send messages, access private credentials, or consume provider quota.

| Script | Purpose |
| --- | --- |
| `web-smoke.mjs` | Browser navigation, responsive layout, media, and interaction checks; also exposed as `pnpm web:smoke` |
| `session-cache-smoke.mjs` | Synthetic browser fixture using the actual sync/store/reducer code |
| `session-cache-production-smoke.mjs` | Production UI/cache behavior with an explicitly prepared test account |
| `reasoning-summary-production-smoke.mjs` | Real reasoning-output UI acceptance |
| `seed-conversation-fixture.mjs`, `seed-session-cache-production.mjs` | Prepare test records for isolated acceptance |
| `analyze-session-cache-heap.mjs` | Analyze an existing private heap snapshot |
| `encode-smoke-recording.py` | Encode an acceptance recording |
| `fixtures/session-cache.ts` | Browser fixture source; synthetic platform adapters |

Browser scripts use `CHROMIUM_PATH` when configured, otherwise `chromium` on `PATH`.
Point them at a prepared test deployment, for example:

```bash
CHROMIUM_PATH=/path/to/chromium pnpm web:smoke --url=http://127.0.0.1:12345
```

Keep screenshots, traces, logs, seeds, heap snapshots, and installation-specific
reports in ignored local storage such as `.runtime/` or `artifacts/`.
