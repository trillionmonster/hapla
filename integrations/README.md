# Optional integrations

These components are independent of the four-package pnpm workspace. The base
Hapla build and Docker deployment do not install or run them.

| Directory | Status | Setup |
| --- | --- | --- |
| `local-asr/` | Optional GPU-hosted speech recognition service | [ASR guide](local-asr/README.md); Python environment and model weights are local |
| `r2-download-gateway/` | Experimental Cloudflare Worker; not part of the standard download path | [Gateway guide](r2-download-gateway/README.md); independent npm lockfile |

Local `r2-cache/` and `r2-download/` directories, if present, are ignored independent
worktrees of an external service. They are not shipped or required by a clone.
Configure the deployed service through [Hapla's file-delivery adapter](../docs/cloudflare.md).
