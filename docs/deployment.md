# Start and deploy Hapla

For guided configuration and deployment, run `./deploy.sh` from a clone. See
[one-command quick start](quickstart.md) and [environment isolation](environment-isolation.md)
for separate instances and per-user workers. The detailed manual paths remain below.

Hapla has two small deployment planes:

- The Web client and encrypted relay server can run on a shared host.
- The Hapla CLI, Codex CLI, user workspace, Skills, and interactive Skill services run on the user's machine.

Do not put Codex credentials, workspace files, or Skill secrets in the Web container. The browser reaches local capabilities through Hapla's encrypted session RPC.

## Local development

Requirements: Node.js 22+, pnpm 10.11.0, and Codex CLI or Claude Code.

```bash
pnpm install --frozen-lockfile
pnpm build
```

Follow [local development](development.md) for a persistent master secret and matching relay/Web addresses. For manual processes, use separate terminals:

```bash
HAPLA_MASTER_SECRET=your-persistent-local-secret pnpm server
EXPO_PUBLIC_HAPLA_SERVER_URL=http://127.0.0.1:3005 pnpm web
HAPLA_SERVER_URL=http://127.0.0.1:3005 HAPLA_WEBAPP_URL=http://localhost:8081 pnpm cli codex
```

The Web development server is available on the address printed by Expo. Use `pnpm --filter hapla-web web:lan` when testing from a phone on the same network.

## Production build

```bash
pnpm build
EXPO_PUBLIC_HAPLA_SERVER_URL=https://hapla.example.com pnpm web:build
```

The static Web export is written to `packages/hapla-web/dist`. It can be served by any static host if WebSocket and API paths are routed to `hapla-server`.

For a direct local deployment without Docker, serve the validated export with Hapla's SPA-aware static server:

```bash
HAPLA_WEB_HOST=0.0.0.0 HAPLA_WEB_PORT=12345 pnpm web:serve
```

`web:serve` places each exported static release under a content-derived directory and returns immutable caching headers only for that versioned namespace. Application routes use `no-cache`; legacy unversioned static paths must revalidate. The server serves pre-compressed files when present and falls back to `index.html` only for client routes. Build the public relay URL into the export with `EXPO_PUBLIC_HAPLA_SERVER_URL`; this does not change the CLI's local `HAPLA_SERVER_URL`.

## Docker self-hosting

Copy [`.env.selfhost.example`](../.env.selfhost.example) to `.env.selfhost` and set a long random secret:

```dotenv
HAPLA_MASTER_SECRET=replace-with-a-long-random-secret
PUBLIC_URL=
```

Compose maps `HAPLA_MASTER_SECRET` to the relay's retained encrypted-storage key. Changing its value invalidates existing encrypted deployments.

Validate the Compose graph before changing live containers:

```bash
pnpm selfhost:check
```

Build and start the relay plus Web app:

```bash
pnpm selfhost:up
```

The wizard prints the selected URL and defaults to local-only access. With the manual environment example, open `http://localhost:12345`, or `http://<host-lan-ip>:12345` from the LAN. Port 9980 is reserved for the separate legacy Web service and Hapla's deployment guard refuses to use it. Set `HAPLA_BIND_ADDRESS=127.0.0.1` in `.env.selfhost` when the service must remain local-only. Put your existing HTTPS reverse proxy in front before exposing it to an untrusted network.

Stop the deployment without deleting its named data volume:

```bash
pnpm selfhost:down
```

The base Compose services are `server` and `web`. The Nginx Web image proxies `/v1`, `/v3`, `/files`, `/socket.io`, and `/health` to the internal server. The server port is not published on the host.

### Recovery after host restart

Both services use `restart: always`. On Linux, Docker must also be enabled at
boot (`systemctl is-enabled docker.service`). A manually stopped container will
start again when Docker restarts; `selfhost:down` removes the containers and
therefore disables their automatic startup until the next `selfhost:up`.

When retaining a stopped container for rollback, set its restart policy to
`no` before renaming it: `docker update --restart=no <container>`. Restore the
original policy only when promoting that container back to production. A
retained server must never start alongside production against the same PGlite
data directory; concurrent instances can corrupt both records and indexes.

Use Docker service names and dynamically assigned container addresses. Do not
pin `server` or `web` to an address inside a shared dynamic allocation pool:
another container can claim that address first after a reboot. Nginx resolves
`server` through Docker DNS at runtime, so it can start before the relay and
follow address changes. This requires Nginx 1.27.3 or newer. CLI daemons retry
initial connection failures as well as later disconnects.

## Interactive Skill deployment

Interactive Skill MCP servers are not long-running services in the central Docker stack. Hapla discovers `.hapla/interactive.json` beside enabled local Skills and asks Codex to launch each server for that thread. This keeps asset libraries, API keys, and generation tools on the machine that owns the workspace.

For a remote HTTP MCP service, configure its launcher script in the Skill directory or extend the manifest schema in a future version. The current schema intentionally supports local process servers only so lifecycle, environment inheritance, and shutdown stay deterministic.

## Release checks

Before deployment:

```bash
pnpm check
pnpm test
pnpm web:build
pnpm selfhost:check
```

Then test one desktop browser and one phone browser. Verify session reconnect, iframe unload/reload, an MCP `tools/call`, a structured submission, and the generated result appearing in the main conversation.

## Optional integrations

See [configuration](configuration.md) for environment variables, [deployment templates](../deploy/README.md) for optional Compose overrides, and [Cloudflare](cloudflare.md) for external R2 delivery and the experimental Worker. ASR requires an explicit `HAPLA_ASR_URL` reachable from the server container. These integrations are not started by the default deployment.

After the Web entry is running, install and authenticate a supported agent CLI on the workspace machine. From a built checkout, run `pnpm cli auth login` and then `pnpm cli daemon start`, with `HAPLA_SERVER_URL` and `HAPLA_WEBAPP_URL` pointing to the deployed Web origin. This connects the machine used by Web-created sessions.
