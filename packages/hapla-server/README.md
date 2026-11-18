# Hapla Server

Encrypted synchronization and RPC relay for the Hapla Web workspace and local CLI daemon.

## Development

From the repository root:

```bash
pnpm install --frozen-lockfile
HAPLA_MASTER_SECRET=your-persistent-local-secret pnpm server
```

The root command starts the embedded PGlite server and applies migrations. See [local development](../../docs/development.md) for generating and retaining a master secret. The default local port is `3005`. Type-check and test with:

```bash
pnpm --filter hapla-server build
pnpm --filter hapla-server test
```

## Self-hosting

Use the repository-level Compose graph described in [`../../docs/deployment.md`](../../docs/deployment.md). The standalone server uses embedded PGlite and local file storage.

Required configuration:

- `HAPLA_MASTER_SECRET`: server signing/encryption secret.
- `PORT`: HTTP and WebSocket port; defaults to `3005`.
- `PUBLIC_URL`: optional externally reachable file URL base; empty uses same-origin `/files`.
- `DATA_DIR` and `PGLITE_DIR`: persistent data locations.

The server stores end-to-end encrypted session payloads and never receives the client-side content key.
