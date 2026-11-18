"""Exercise real streaming ASR, endpoint detection, stop-flush, and silence."""
import argparse
import asyncio
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr
import websockets


async def run_case(url, path=None, language=None, *, realtime=False, stop_early=False):
    if path:
        audio, sr = sf.read(path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != 16000:
            audio = soxr.resample(audio, sr, 16000)
        if stop_early:
            audio = audio[:16000 * 3 + 123]
        else:
            audio = np.concatenate((audio, np.zeros(16000, dtype=np.float32)))
    else:
        audio = np.zeros(16000 * 3, dtype=np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    messages = []
    started = time.perf_counter()
    async with websockets.connect(url, max_size=2**20) as ws:
        await ws.send(json.dumps({"type": "start", "language": language}))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready", ready

        async def collect():
            async for raw in ws:
                event = json.loads(raw)
                messages.append(event)
                if event["type"] in ("partial", "final", "speech_start", "speech_end", "error"):
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                if event["type"] == "error":
                    raise AssertionError(event)
                if event["type"] == "stopped":
                    return

        reader = asyncio.create_task(collect())
        for pos in range(0, len(pcm), 512):
            await ws.send(pcm[pos:pos + 512].tobytes())
            if realtime:
                await asyncio.sleep(512 / 16000)
            else:
                await asyncio.sleep(0.001)
        await ws.send(json.dumps({"type": "stop"}))
        await asyncio.wait_for(reader, timeout=120)
    final = [m for m in messages if m["type"] == "final" and m["text"]]
    if path:
        assert final, "Expected an actual transcription"
        if not stop_early:
            assert any(m["type"] == "speech_end" and m["reason"] == "silence" for m in messages), "Silence did not finalize speech"
        else:
            assert any(m["type"] == "speech_end" and m["reason"] == "manual" for m in messages), "Manual stop did not flush"
        assert any(m["type"] == "partial" and m["text"] for m in messages), "No incremental text"
    else:
        assert not final and not any(m["type"] == "speech_start" for m in messages), "Silence produced hallucinated speech"
    print(json.dumps({"case": str(path) if path else "silence", "audio_sec": round(len(pcm) / 16000, 2),
                      "wall_sec": round(time.perf_counter() - started, 2),
                      "partials": sum(m["type"] == "partial" for m in messages),
                      "final_text": "\n".join(m["text"] for m in final)}, ensure_ascii=False), flush=True)
    return messages


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:8765/ws")
    parser.add_argument("--samples", type=Path, default=Path(__file__).resolve().parents[2] / ".runtime/local-asr/samples")
    parser.add_argument("--realtime", action="store_true")
    args = parser.parse_args()
    await run_case(args.url)
    await run_case(args.url, args.samples / "zh.wav", "Chinese", realtime=args.realtime)
    await run_case(args.url, args.samples / "en.wav", "English", realtime=args.realtime)
    await run_case(args.url, args.samples / "zh.wav", "Chinese", stop_early=True)
    print("ALL STREAMING CHECKS PASSED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
