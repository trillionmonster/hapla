# Deployment templates

Start with the root [Compose file](../docker-compose.selfhost.yml),
[environment example](../.env.selfhost.example), and [deployment guide](../docs/deployment.md).
The one-command [wizard](../docs/quickstart.md) applies the base file and automatically includes the external file-service override when configured. Other local overrides need an explicit Compose file list.

| File | Applies to | Purpose |
| --- | --- | --- |
| `compose.worker.yml`, `Dockerfile.worker` | Optional per-user worker | Separate home/workspace volumes, non-root CLI image, shared relay network; see [isolation](../docs/environment-isolation.md) |
| `compose.subnet.yml` | Hapla base Compose | Optional private subnet for deployments with exhausted Docker address pools |
| `nginx.conf` | `Dockerfile.webapp` | Static Web hosting plus API, files, and WebSocket proxy |
| `hapla-cloud-files.override.yml` | Hapla base Compose | Optional external upload/restore service; requires `HAPLA_R2_CACHE_URL` |
| `compose.lan-files.yml` | Hapla base Compose | Optional read-only NAS originals and database access; see [LAN delivery](../docs/lan-file-delivery.md) |
| `r2-hapla.override.yml` | External file-service Compose | File-service image and media mounts; requires `HAPLA_R2_CACHE_IMAGE` and `MEDIA_DIR` |
| `r2-download.override.yml` | External file-service Compose | Explicit API image selection for its download endpoint |
| `cloudflare/r2-cors.example.json` | Cloudflare R2 | Wrangler-format private-bucket CORS example with placeholder origins |

External service overrides are not standalone Compose applications and do not
define services for the Hapla base graph. Their image must come from the separately
maintained service. See [Cloudflare configuration](../docs/cloudflare.md) for merge
commands and the distinction between service, bucket, and Worker settings.

Validate the complete file list with `docker compose ... config --quiet` before
starting an optional deployment. Local `*.local.yml` and `*.local.json` files under
this directory are ignored. Keep data, secrets, and rollback images outside Git.
