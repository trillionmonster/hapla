# Configuration reference

Commit sanitized examples; keep actual deployment values in ignored local files.
The default Docker instance reads `.env.selfhost`; named one-click instances read `.runtime/selfhost/<instance>/.env`. Direct Node/CLI processes read their
environment; they do not automatically load `.env.selfhost`.

## Self-hosted server and Web

| Variable | Default | Purpose |
| --- | --- | --- |
| `HAPLA_MASTER_SECRET` | Required | Server signing and storage encryption key; generate a long random secret and retain it with backups |
| `PUBLIC_URL` | Empty | Public file URL base; empty uses the same Web origin for `/files` |
| `HAPLA_WEBAPP_URL` | `http://localhost:12345` in Compose | Browser destination after optional GitHub OAuth callbacks |
| `HAPLA_ACCESS_PASSWORD_HASH` | Empty | Optional global entry gate; a scrypt hash, never a plaintext password |
| `HAPLA_BIND_ADDRESS` | `127.0.0.1` in the wizard; `0.0.0.0` in manual Compose | Host interface published by the Web container |
| `HAPLA_PORT` | Wizard searches from `12345`; manual Compose uses `12345` | Published Web port; 9980 remains reserved by the deployment guard |
| `HAPLA_DOCKER_SUBNET` | Docker selects the subnet | Optional private IPv4 CIDR for a named network when Docker's default address pool is exhausted |
| `HAPLA_ASR_URL` | Empty | Optional ASR endpoint reachable from the server container; must be explicitly configured |
| `HAPLA_PREVIEW_HOST_TEMPLATE` | Empty | Per-proxy isolated hostname, e.g. `{handle}.preview.example.com`; wildcard DNS/TLS and every forwarding hop must reach the same Web. Required for sharing; preserves the browser's actual scheme and port |
| `HAPLA_ASR_PAGE_URL` | Empty | Public HTTPS dictation-page URL compiled into the Web image |

The one-click wizard preserves the existing master secret and generates it only for a fresh installation.
`HAPLA_SERVER_IMAGE` and `HAPLA_WEB_IMAGE` select local image tags; the wizard gives each named instance its own tags.
`--instance` selects the Compose project and database/network namespace; it is not a user account.
See [quick start](quickstart.md) and [environment isolation](environment-isolation.md).

For a non-container standalone server, `PORT` defaults to 3005, `DATA_DIR` defaults
to `./data`, and `PGLITE_DIR` defaults to `$DATA_DIR/pglite`. Paths are relative to
the server process's working directory. Use a single server writer per PGlite directory.

Generate an optional entry password hash with:

```bash
node scripts/hash-site-access-password.cjs < /path/to/private-password.txt
```

Put the result in single quotes in `.env.selfhost` so Compose preserves its `$`
separators. Existing authenticated accounts continue to use their account tokens.
Keep plaintext password files outside the checkout.

An ASR service on the Docker host needs an address reachable from inside the
container; container loopback points at the container itself. Configure a host
gateway or a reachable private hostname in your local Compose override. See the
[ASR integration](../integrations/local-asr/README.md).

## Local CLI

| Variable | Default | Purpose |
| --- | --- | --- |
| `HAPLA_SERVER_URL` | `http://127.0.0.1:12345` | Relay endpoint, including the Web proxy in the standard Docker setup |
| `HAPLA_WEBAPP_URL` | `http://127.0.0.1:12345` | Browser entry used during pairing |
| `HAPLA_HOME_DIR` | `~/.hapla` | Local credentials, daemon state, logs, and recovered user Skills |
| `HAPLA_ACCESS_PASSWORD` | Unset | Entry password for initial login to a protected server; keep out of shell history |
| `HAPLA_CODEX_PATH` | Installed Codex | Optional explicitly selected Codex executable |
| `HAPLA_WORKSPACE_ROOT` | User home | Optional absolute boundary for machine file and terminal RPCs |

Provider variables entered on the new-session screen are passed to the selected
Claude Code or Codex process through encrypted machine RPC. Values stay in page
memory until submission; browser storage remembers variable names, not secret values.

## Web build and static hosting

| Variable | Used by | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_HAPLA_SERVER_URL` | `pnpm web`, `pnpm web:build` | Public relay URL; empty uses the browser origin |
| `EXPO_PUBLIC_ASR_URL` | Direct Web builds | Optional public HTTPS dictation-page URL |
| `HAPLA_SERVER_URL` build argument | `Dockerfile.webapp` | Maps to `EXPO_PUBLIC_HAPLA_SERVER_URL`; empty for the same-origin Nginx deployment |
| `HAPLA_ASR_PAGE_URL` build argument | `Dockerfile.webapp` | Maps to `EXPO_PUBLIC_ASR_URL` |
| `HAPLA_WEB_HOST`, `HAPLA_WEB_PORT` | `pnpm web:serve` | Static listener address and port |

`EXPO_PUBLIC_*` values are embedded in downloadable JavaScript. Never place
credentials or signed URLs in these values. A browser's saved custom server
selection takes precedence over the compiled relay URL.

## Optional file delivery and Cloudflare

`HAPLA_R2_CACHE_URL` is the external file service's HTTP endpoint, used with
`deploy/hapla-cloud-files.override.yml`. R2 object credentials belong in that service's
own secret store, not in Hapla Web. LAN original-file access has additional mount,
read-only database, and network settings in [LAN file delivery](lan-file-delivery.md).

The optional Worker has three non-secret settings: `R2_ORIGIN`, `R2_BUCKET`, and
`ALLOWED_ORIGINS`. Deployment authentication uses Wrangler login or a
`CLOUDFLARE_API_TOKEN` scoped for Workers deployment; it is separate from R2 S3 keys.
See [Cloudflare setup](cloudflare.md) for configuration files, CORS, and validation.
