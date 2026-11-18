# Cloudflare file delivery

The standard Hapla deployment runs a static Web container and a PGlite server.
Cloudflare is optional. The repository contains an external-file-service adapter,
an experimental download Worker, and a bucket CORS example; these are separate
configuration surfaces.

## External R2 file service

The public file path uses a separately operated service with `/v1/upload` and
`/v1/restore`. R2 credentials, signing, quotas, and original-file retention belong
to that service. Its source is not included here.

Set `HAPLA_R2_CACHE_URL` in `.env.selfhost`, then merge the Hapla adapter:

```bash
docker compose --env-file .env.selfhost \
  -f docker-compose.selfhost.yml \
  -f deploy/hapla-cloud-files.override.yml config --quiet
docker compose --env-file .env.selfhost \
  -f docker-compose.selfhost.yml \
  -f deploy/hapla-cloud-files.override.yml up -d --build
```

`./deploy.sh` and `pnpm selfhost:up` automatically include the external-service override
when `HAPLA_R2_CACHE_URL` is configured (or through `--file-service`). For manual Compose
commands, continue using the same complete file list when updating an installation. The `deploy/r2-*.override.yml`
files target the external service's own Compose graph and require an explicit
`HAPLA_R2_CACHE_IMAGE`; do not merge them into Hapla's two-service graph.

## Private bucket CORS

Presigned URLs authenticate access to private objects, but browsers still need a
bucket CORS policy. Copy
[`deploy/cloudflare/r2-cors.example.json`](../deploy/cloudflare/r2-cors.example.json)
to `deploy/cloudflare/r2-cors.local.json` and replace the example origins with
the exact origins used by your Web clients (scheme, host, and port).

The example uses Wrangler's `rules`/`allowed` JSON format. It allows GET/HEAD and
exposes the headers used by media Range requests and downloads. It does not allow
uploads or turn the bucket public. Do not paste AWS S3 `CORSRules` JSON into this
Wrangler command.

With an authenticated Wrangler installation and permissions to manage bucket CORS:

```bash
cd integrations/r2-download-gateway
npm ci
npx wrangler r2 bucket cors set YOUR_BUCKET_NAME --file ../../deploy/cloudflare/r2-cors.local.json
npx wrangler r2 bucket cors list YOUR_BUCKET_NAME
```

Setting CORS replaces the bucket policy. Review and preserve any rules required by
other clients. Use an existing valid signed URL to verify GET, HEAD, Range, and
exposed headers from the actual browser origin. A successful command alone does
not establish browser playback or download performance.

## Experimental download Worker

[`integrations/r2-download-gateway`](../integrations/r2-download-gateway/README.md)
streams an existing signed GET URL through a Worker. It holds no R2 keys or bucket
binding and accepts only the configured R2 S3 origin and bucket. R2 still verifies
the original signature. The Worker is not wired into the standard Hapla download
path and has no established public-network speed benefit.

Generate the ignored `wrangler.local.jsonc` using explicit values:

```bash
cd integrations/r2-download-gateway
npm ci
python3 scripts/prepare-config.py \
  --r2-origin https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com \
  --bucket your-private-bucket \
  --allowed-origins https://hapla.example.com,http://localhost:12345 \
  --name your-download-gateway
npm test
npm run typecheck
npx wrangler deploy --config wrangler.local.jsonc --dry-run
```

| Setting | Meaning |
| --- | --- |
| `name` | Worker resource name; choose a name for your account |
| `R2_ORIGIN` | Exact HTTPS R2 S3 endpoint, without a bucket path, query, or credentials |
| `R2_BUCKET` | Private bucket name accepted by the gateway |
| `ALLOWED_ORIGINS` | Comma-separated browser origins; no paths or wildcard |
| `compatibility_date` | Pinned runtime behavior, updated together with Wrangler/runtime validation |
| `workers_dev` | Enables the Worker's `workers.dev` entry |
| `preview_urls` | Disabled in the template |
| `observability.redact_query_string` | Removes URL query strings from observability records |
| `observability.logs.invocation_logs` | Disabled to avoid automatic request-URL logs |

The checked-in config contains placeholders and supports local build validation.
Use the generated local config for actual deployment. Wrangler login or a suitably
scoped `CLOUDFLARE_API_TOKEN` authorizes Worker deployment; R2 S3 access keys cannot
deploy Workers. Keep tokens in the process environment or CI secret store.

After reviewing the dry run, an operator can deploy with
`npx wrangler deploy --config wrangler.local.jsonc`. Test real browser Range/If-Range,
stream cancellation, expired signatures, attachment filenames, and full-file hashes
before adopting the gateway. Signed URLs are temporary credentials; never paste
them into issues, build variables, or logs.

References: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
