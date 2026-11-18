# Local streaming ASR

Optional Qwen3-ASR-1.7B and Silero VAD service with a browser dictation page.
Inference runs on the operator's GPU; microphone audio and transcription stay in
service memory. This is independent of the default Hapla deployment.

## Install

Use Python 3.12, `uv`, and an NVIDIA GPU/driver that supports the model's BF16
inference dependencies. Run from the Hapla repository root:

```bash
uv venv .runtime/local-asr/.venv --python 3.12
uv pip install --python .runtime/local-asr/.venv/bin/python -r integrations/local-asr/requirements.txt
.runtime/local-asr/.venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("Qwen/Qwen3-ASR-1.7B", local_dir=".runtime/local-asr/model")'
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .runtime/local-asr/.venv/bin/python integrations/local-asr/server.py
```

`requirements.txt` pins direct dependencies; `requirements.lock.txt` records the
full environment used for historical validation and is hardware-specific.
Model weights and the Python environment are ignored local data.

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASR_MODEL` | `.runtime/local-asr/model` under the repository | Local model weights |
| `ASR_HOST` | `127.0.0.1` | Listener address |
| `ASR_PORT` | `8765` | HTTP/WebSocket port |

Open `http://localhost:8765` on the ASR machine. Remote microphone access requires
trusted HTTPS. `compose.https.yml` provides a Linux host-network Nginx proxy using
certificates under `.runtime/local-asr/tls/`; supply `server.crt`, `server.key`,
and `rootCA.crt` for your own hostname before starting it. Protect the service at
the network boundary; the standalone page is not a Hapla account login surface.

Set Hapla's `HAPLA_ASR_URL` to an address reachable from its server container.
Set `HAPLA_ASR_PAGE_URL` only when an HTTPS dictation page is needed for a local
HTTP Web entry. Neither variable has a machine-specific default. See
[Web interaction](../../docs/web-interaction-features.md) and
[configuration](../../docs/configuration.md).

For a user systemd service, copy `local-asr.service` to
`~/.config/systemd/user/`, adapt `WorkingDirectory`, `ExecStart`, and `ASR_MODEL`
to your checkout, then run `systemctl --user daemon-reload` and
`systemctl --user enable --now local-asr`. The template assumes `~/hapla` and
listens only on loopback; choose an explicit network address if needed.

## Behavior and validation

The page sends 16 kHz mono PCM16 through WebSocket and updates text incrementally.
Silence detection finalizes a segment; stopping flushes tail audio. One recording
session owns the model at a time. Transcription remains in page memory until copied
or exported; refreshing the page discards it.

`smoke_test.py` checks real sample transcription and streaming. It requires prepared
sample audio in `.runtime/local-asr/samples/` and a running service:

```bash
.runtime/local-asr/.venv/bin/python integrations/local-asr/smoke_test.py
```

Upstream: [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR),
[Silero VAD](https://github.com/snakers4/silero-vad).
