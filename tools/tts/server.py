"""Speech for the avatar, as a local service.

The renderer needs two things from a voice: the audio to play, and how long it
actually lasts. The mouth layer estimates the second from text when it has to,
but an estimate drifts against real speech — so this returns the audio and the
measured duration together, and the caller drives the mouth off the measurement.

    orchestrator ──POST /speak──► this ──wav + X-Speech-Seconds──► viewer

**Binds to 127.0.0.1 only, on the same licence condition as the control API.**
The voice is cloned from recordings that are not ours to republish, which is a
stronger reason than the avatar's, not a weaker one. There is no CORS header
here either, and adding one is a licensing decision before it is a code change.

The model is loaded once and stays resident: loading costs about sixteen
seconds, and a process that pays that per line is not a voice, it is a batch
job. Generation is not streamed — this architecture produces a whole utterance
at once — so the time to the first sample is the time to the last one. At the
default step count that is roughly half a second for a normal line, which is
why the caller is expected to send one line at a time rather than a paragraph.

usage: .venv/bin/python server.py [--port 8770]
"""

import argparse
import io
import threading
import time
from contextlib import asynccontextmanager

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from irodori_tts.inference_runtime import InferenceRuntime, SamplingRequest
from pydantic import BaseModel, Field

from config import (
    DEFAULT_SEED,
    DEFAULT_STEPS,
    DEVICE,
    LATENTS,
    MAX_SECONDS,
    REF_NORMALIZE_DB,
    runtime_key,
)

BIND = "127.0.0.1"  # do not change; see the module docstring
DEFAULT_PORT = 8770

# One line at a time through the model, whatever arrives.
#
# `speak` is a plain `def`, so FastAPI runs it in a threadpool and several
# requests genuinely execute at once. The model does not survive that: two
# threads driving the same MPS context race on the Metal command queue and the
# process dies on an assertion inside the driver —
#
#     -[IOGPUMetalCommandBuffer validate]: commit an already committed
#     command buffer
#
# — which takes the voice down for every caller, not just the one that raced.
# Serialising costs nothing real, because a single GPU was only ever going to
# do these one after another anyway. It is a lock rather than a single worker so
# that `/health` stays answerable while a line is being made.
_gpu = threading.Lock()

_runtime: InferenceRuntime | None = None
_latents: list[str] = []


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    # Style, as a sentence. The voice comes from the reference clips and stays
    # put; this only changes the delivery — "明るく元気な声で" and so on. It is
    # per-request because a line's mood is a property of the line.
    caption: str | None = None
    # Exposed because a caller that wants a cheap preview can drop it, but the
    # default is the measured optimum and lowering it costs speaker identity
    # before it costs anything else. See `config.DEFAULT_STEPS`.
    steps: int = Field(default=DEFAULT_STEPS, ge=1, le=64)
    # None asks for a different delivery each time; the default repeats.
    seed: int | None = DEFAULT_SEED


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _runtime, _latents
    _latents = sorted(str(p) for p in LATENTS.glob("*.pt"))
    if not _latents:
        raise RuntimeError(f"no reference latents in {LATENTS}; run refs.py first")
    _runtime = InferenceRuntime.from_key(runtime_key())
    # One short synthesis so the first real line does not pay for the backend
    # compiling its kernels — which it otherwise does, visibly, mid-sentence.
    _runtime.synthesize(
        SamplingRequest(
            text="テスト", ref_latents=_latents, num_steps=DEFAULT_STEPS, seed=DEFAULT_SEED
        )
    )
    print(f"speech ready on {DEVICE}: {len(_latents)} reference latents", flush=True)
    yield


app = FastAPI(title="aituber speech", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ready": _runtime is not None,
        "device": DEVICE,
        "refs": len(_latents),
        "steps": DEFAULT_STEPS,
        "max_seconds": MAX_SECONDS,
    }


@app.post("/speak")
def speak(req: SpeakRequest) -> Response:
    if _runtime is None:
        raise HTTPException(status_code=503, detail="model still loading")

    started = time.perf_counter()
    with _gpu:
        result = _runtime.synthesize(
            SamplingRequest(
                text=req.text,
                caption=req.caption,
                ref_latents=_latents,
                num_steps=req.steps,
                seed=req.seed,
                ref_normalize_db=REF_NORMALIZE_DB,
                max_seconds=MAX_SECONDS,
            )
        )
        audio = result.audio.squeeze().cpu().numpy()
    seconds = len(audio) / result.sample_rate

    buffer = io.BytesIO()
    sf.write(buffer, audio, result.sample_rate, format="WAV", subtype="PCM_16")
    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            # The measured length of this take, which is the number the mouth
            # runs on. A caller that trusts its own estimate instead will drift.
            "X-Speech-Seconds": f"{seconds:.3f}",
            "X-Speech-Generate-Seconds": f"{time.perf_counter() - started:.3f}",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    uvicorn.run(app, host=BIND, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
