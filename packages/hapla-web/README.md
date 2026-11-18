# Hapla Web

Expo Router and React Native Web client for the Hapla workspace. The supported
distribution is Web; native application shells are not included.

From the repository root, install dependencies with `pnpm install --frozen-lockfile`,
then start the [local relay](../../docs/development.md) and Web development server:

```bash
EXPO_PUBLIC_HAPLA_SERVER_URL=http://127.0.0.1:3005 pnpm web
```

| Command (repository root) | Purpose |
| --- | --- |
| `pnpm --filter hapla-web typecheck` | Type-check Web source |
| `pnpm --filter hapla-web test --run` | Run Web tests |
| `pnpm web:build` | Export static Web assets and validate bundle boundaries |
| `pnpm web:serve` | Serve a previously built static export |

Application source lives under `sources/`; assets, Expo configuration, and Web
public files remain package-local. Optional renderers and media controls load at
their feature boundaries. The production export is written to `dist/` and is ignored.

See [configuration](../../docs/configuration.md), [deployment](../../docs/deployment.md),
and the [documentation index](../../docs/README.md) for runtime behavior and supported integrations.
