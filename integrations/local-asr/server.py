"""Local Qwen3-ASR streaming service. Audio stays in memory on this machine."""
import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import importlib.util
import json
import logging
import os
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("ASR_MODEL", str(ROOT.parents[1] / ".runtime/local-asr/model"))
SR = 16000
FRAME = 512
FRAME_MS = FRAME / SR * 1000
log = logging.getLogger("local-asr")


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = "start"
    sample_rate: int = Field(default=SR, ge=SR, le=SR)
    silence_ms: int = Field(default=700, ge=300, le=2000)
    vad_threshold: float = Field(default=0.5, ge=0.2, le=0.9)
    chunk_sec: float = Field(default=1.0, ge=0.5, le=2.0)
    language: str | None = None
    context: str = Field(default="", max_length=1000)


class Vad:
    """One recurrent Silero state per client; immutable ONNX session is shared."""
    def __init__(self, session):
        self.session = session
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, 64), dtype=np.float32)

    def __call__(self, frame):
        x = np.concatenate((self.context, frame.reshape(1, -1)), axis=1)
        score, self.state = self.session.run(None, {
            "input": x, "state": self.state, "sr": np.array(SR, dtype=np.int64),
        })
        self.context = x[:, -64:].copy()
        return float(score[0, 0])


class Engine:
    def __init__(self):
        self.asr = None
        self.vad = None
        self.busy = False
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")

    def load(self):
        from qwen_asr import Qwen3ASRModel
        spec = importlib.util.find_spec("silero_vad")
        vad_path = Path(next(iter(spec.submodule_search_locations))) / "data/silero_vad.onnx"
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.vad = ort.InferenceSession(str(vad_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.asr = Qwen3ASRModel.LLM(
            model=MODEL, dtype="bfloat16", gpu_memory_utilization=0.32,
            max_model_len=4096, max_num_seqs=4, max_num_batched_tokens=4096,
            max_new_tokens=128, enforce_eager=True,
            limit_mm_per_prompt={"audio": 1}, disable_log_stats=True,
        )
        # Pay the first CUDA/kernel initialization cost before accepting a microphone.
        self.asr.transcribe(audio=(np.zeros(SR, dtype=np.float32), SR), language="Chinese")
        log.info("Qwen3-ASR-1.7B + Silero VAD ready")

    async def run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, fn, *args)


engine = Engine()


@asynccontextmanager
async def lifespan(app):
    engine.load()
    yield
    engine.executor.shutdown(wait=True)


app = FastAPI(title="Local ASR", lifespan=lifespan)


@app.middleware("http")
async def privacy_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Permissions-Policy"] = "microphone=(self)"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
    return response


@app.get("/api/health")
async def health():
    return {"ready": engine.asr is not None, "model": "Qwen3-ASR-1.7B", "backend": "vLLM",
            "vad": "Silero VAD 6.2", "device": "NVIDIA RTX 5090", "busy": engine.busy,
            "sample_rate": SR, "offline": True, "max_utterance_sec": 20}


@app.get("/")
async def index():
    return FileResponse(ROOT / "web/index.html")


class Stream:
    def __init__(self, ws, settings):
        self.ws, self.settings = ws, settings
        self.vad = Vad(engine.vad)
        self.pre = deque(maxlen=10)  # 320 ms pre-roll protects the first syllable.
        self.pending = []
        self.state = None
        self.active = False
        self.sample_index = 0
        self.start_sample = 0
        self.speech_run = 0
        self.silence_ms = 0
        self.last_meter = 0
        self.last_text = ""
        self.segment = 0
        self.last_decode_ms = None
        self.speech_samples = 0

    async def emit(self, kind, **data):
        await self.ws.send_json({"type": kind, **data})

    async def decode(self, final=False):
        started = time.perf_counter()
        previous_chunk = self.state.chunk_id
        if self.pending:
            audio = np.concatenate(self.pending)
            self.pending.clear()
            await engine.run(engine.asr.streaming_transcribe, audio, self.state)
        if final:
            await engine.run(engine.asr.finish_streaming_transcribe, self.state)
        if self.state.chunk_id != previous_chunk:
            self.last_decode_ms = round((time.perf_counter() - started) * 1000)
        text = self.state.text.strip()
        if text != self.last_text or final:
            self.last_text = text
            await self.emit("final" if final else "partial", text=text,
                            segment=self.segment, language=self.state.language,
                            start=round(self.start_sample / SR, 3),
                            end=round(self.sample_index / SR, 3), decode_ms=self.last_decode_ms)

    async def finish(self, reason):
        if not self.active:
            return
        await self.decode(final=True)
        await self.emit("speech_end", segment=self.segment, reason=reason)
        self.active = False
        self.state = None
        self.pending.clear()
        self.pre.clear()
        self.speech_run = 0
        self.silence_ms = 0
        self.last_text = ""

    async def frame(self, frame):
        self.sample_index += FRAME
        probability = self.vad(frame)
        rms = float(np.sqrt(np.mean(frame ** 2)))
        threshold = self.settings.vad_threshold
        if not self.active:
            self.pre.append(frame.copy())
            self.speech_run = self.speech_run + 1 if probability >= threshold else 0
            if self.speech_run >= 3:  # Require 96 ms of speech rather than a click.
                self.active = True
                self.segment += 1
                self.start_sample = self.sample_index - len(self.pre) * FRAME
                self.state = engine.asr.init_streaming_state(
                    language=self.settings.language, context=self.settings.context,
                    unfixed_chunk_num=2, unfixed_token_num=5,
                    chunk_size_sec=self.settings.chunk_sec)
                self.pending = list(self.pre)
                self.pre.clear()
                self.silence_ms = 0
                self.speech_samples = self.speech_run * FRAME
                await self.emit("speech_start", segment=self.segment, start=self.start_sample / SR)
        else:
            self.pending.append(frame.copy())
            if probability >= max(0.05, threshold - 0.15):
                self.silence_ms = 0
                self.speech_samples += FRAME
            else:
                self.silence_ms += FRAME_MS
            if self.silence_ms >= self.settings.silence_ms:
                await self.finish("silence")
            elif (self.sample_index - self.start_sample) / SR >= 20:
                await self.finish("duration_limit")
            elif len(self.pending) * FRAME >= self.state.chunk_size_samples:
                await self.decode()
        if self.sample_index - self.last_meter >= SR / 8:
            self.last_meter = self.sample_index
            await self.emit("vad", probability=round(probability, 4), rms=round(rms, 5),
                            speaking=self.active, silence_ms=round(self.silence_ms),
                            elapsed=round(self.sample_index / SR, 2), decode_ms=self.last_decode_ms)


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    # Reject cross-site microphone sessions, while allowing local CLI tests without Origin.
    from urllib.parse import urlsplit
    origin = ws.headers.get("origin")
    if origin and urlsplit(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)
        return
    await ws.accept()
    if engine.busy:
        await ws.send_json({"type": "error", "message": "已有录音会话正在使用模型，请先停止该会话。"})
        await ws.close(code=1013)
        return
    engine.busy = True
    stream = None
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
        settings = Settings.model_validate_json(raw)
        if settings.type != "start" or settings.language not in (None, "Chinese", "English", "Cantonese", "Japanese", "Korean"):
            raise ValueError("无效的启动参数或语言。")
        stream = Stream(ws, settings)
        buffer = np.zeros(0, dtype=np.float32)
        await stream.emit("ready", model="Qwen3-ASR-1.7B", settings=settings.model_dump())
        while True:
            message = await asyncio.wait_for(ws.receive(), timeout=30)
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                data = message["bytes"]
                if not data or len(data) > 32768 or len(data) % 2:
                    raise ValueError("音频需为 16 kHz 单声道 PCM16，每包不超过一秒。")
                if stream.sample_index > SR * 60 * 60:
                    raise ValueError("单次录音已达到一小时，请重新开始。")
                audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
                buffer = np.concatenate((buffer, audio))
                while len(buffer) >= FRAME:
                    await stream.frame(buffer[:FRAME])
                    buffer = buffer[FRAME:]
            elif message.get("text"):
                command = json.loads(message["text"])
                if command.get("type") in ("stop", "flush"):
                    if len(buffer):
                        await stream.frame(np.pad(buffer, (0, FRAME - len(buffer))))
                        buffer = np.zeros(0, dtype=np.float32)
                    await stream.finish("manual")
                    if command["type"] == "stop":
                        await stream.emit("stopped")
                        break
                else:
                    raise ValueError("无效的控制消息。")
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.exception("Streaming session ended with an error")
        try:
            await ws.send_json({"type": "error", "message": str(exc)[:300]})
        except Exception:
            pass
    finally:
        # Wait for a cancelled/disconnected inference to finish before granting the next session.
        await engine.run(lambda: None)
        engine.busy = False
        try:
            await ws.close()
        except Exception:
            pass


app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=os.environ.get("ASR_HOST", "127.0.0.1"),
                port=int(os.environ.get("ASR_PORT", "8765")),
                ws_max_size=65536, ws_max_queue=64)
