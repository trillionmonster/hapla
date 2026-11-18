# Experimental R2 download gateway

This independent Cloudflare Worker streams an existing signed GET URL from one
configured private R2 bucket. It is not part of Hapla's standard download path.
Local protocol checks pass.
No public-network speed improvement is established.

## Validate locally

Requirements: Node.js 22+, npm, and Python 3.10+.

```bash
cd integrations/r2-download-gateway
npm ci
npm test
npm run typecheck
npm run build
```

`npm test` checks signed-link boundaries, streaming, Range/HEAD, cancellation,
CORS, and configuration generation. Type checking generates environment/runtime
types in ignored `.wrangler/types/`. The build is a dry run; it does not deploy.

## Configure an operator-owned endpoint

```bash
python3 scripts/prepare-config.py   --r2-origin https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com   --bucket your-private-bucket   --allowed-origins https://hapla.example.com,http://localhost:12345   --name your-download-gateway
npx wrangler deploy --config wrangler.local.jsonc --dry-run
```

The generated config is ignored and written atomically with private permissions.
There is no default NAS path. If an existing service exposes endpoint metadata,
pass its JSON file explicitly as a positional argument; only `r2_endpoint` and
`r2_bucket` are selected. `--allowed-origins` remains required. No R2 keys are copied.

Worker deployment uses Wrangler login or a scoped Cloudflare API token. R2 S3
access/secret keys do not authorize Worker deployment. After reviewing the config
and dry run, an operator can run `npx wrangler deploy --config wrangler.local.jsonc`.
See [Cloudflare setup](../../docs/cloudflare.md) for bucket CORS and permissions.

## Request and trust boundaries

Request `/file?url=<URL-encoded signed R2 GET URL>`. The gateway fixes the R2 origin
and bucket, rejects redirects and unsigned/expired inputs, and does not forward
browser cookies or authorization headers. It owns no bucket keys or R2 binding;
R2 validates each signature. HEAD uses a one-byte signed GET and cancels the body
so the original GET capability is not incorrectly reused for another method.

Responses use the original stream with no whole-file buffer, Cache API, CDN
cache, or NAS byte proxy. GET Range/If-Range, ETag, and download headers are preserved.
Query strings are redacted from observability and automatic invocation logs are
disabled. Treat signed links as temporary credentials regardless of CORS policy.

Before adoption, verify the public endpoint on the actual device/network:
full-file hashes and speed comparisons, playback and seeking, Range/If-Range,
Unicode filenames, downloads after leaving the page, and expired/tampered links.
Local `wrangler dev` checks protocol behavior, not edge-network performance.
Keep original R2 URLs for the external service's restore API.
