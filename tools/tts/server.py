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
import watermark
from repair import clean_take, close_tail, trim

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
#     -[IOGPUMetalCommandBuffer validate]:215: failed assertion
#     `commit command buffer with uncommitted encoder'
#
# — which takes the voice down for every caller, not just the one that raced.
# Serialising costs nothing real, because a single GPU was only ever going to
# do these one after another anyway. It is a lock rather than a single worker so
# that `/health` stays answerable while a line is being made.
#
# What it guards is *every* call that runs on the device, not synthesis alone.
# The watermarker is a second model on the same MPS context — `encode_one` moves
# the take onto it and encodes there — so a mark left outside this lock races
# synthesis exactly as a second synthesis would, and the second assertion above
# is what that looks like. The repair chain is numpy and libsonare throughout
# and stays outside deliberately: it is the only part of a take that can be made
# while another line is on the GPU.
_gpu = threading.Lock()

_runtime: InferenceRuntime | None = None
_latents: list[str] = []


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    # Style, as a sentence. The voice comes from the reference clips and stays
    # put; this only changes the delivery — "明るく元気な声で" (in a bright,
    # cheerful voice) and so on. It is per-request because a line's mood is a
    # property of the line.
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
    # Before anything is generated: the runtime marks takes on the way out of
    # the decoder, and `speak` needs to mark them at the end instead.
    watermark.claim(_runtime)
    # One synthesis so the first real line does not pay for the backend
    # compiling its kernels — which it otherwise does, visibly, mid-sentence.
    #
    # A sentence rather than a word, because this take is also what the
    # watermark is checked against and the payload needs about a second of audio
    # to be readable back. See `watermark.WATERMARK_MIN_SECONDS`.
    warmup = _runtime.synthesize(
        SamplingRequest(
            text="音声の準備をしています。",
            ref_latents=_latents,
            num_steps=DEFAULT_STEPS,
            seed=DEFAULT_SEED,
        )
    )
    # And it doubles as the proof that marking works, on the real path rather
    # than on a tone. A failure here stops the sidecar: audio that goes out
    # carrying the wrong payload, or none, is worse than no audio at all.
    watermark.self_test(
        _runtime, warmup.audio.squeeze().cpu().numpy(), int(warmup.sample_rate)
    )
    print(f"speech ready on {DEVICE}: {len(_latents)} reference latents", flush=True)
    yield


app = FastAPI(title="hashidate speech", lifespan=lifespan)


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
    # Clean, close, trim, then mark, and the order is the whole design.
    #
    # Close after clean, because it decides whether the take was severed by
    # reading the level of its last few milliseconds, and that reading is only
    # about the voice once the noise under it has gone.
    #
    # Trim after close, because closing cuts back to a pause and leaves it
    # there; trimming is what takes a pause off an end. And `X-Speech-Seconds`
    # below is what the mouth runs on, so it has to be the length of the voice
    # rather than of the file.
    #
    # Mark after all three, because the mark lives about 50 dB under the speech
    # and a denoiser run over the top of it is a denoiser aimed straight at it.
    # See `repair.py` and `watermark.py`.
    audio = trim(close_tail(clean_take(audio, result.sample_rate), result.sample_rate), result.sample_rate)
    with _gpu:
        audio = watermark.mark(_runtime, audio, result.sample_rate)
    # Measured off the buffer that is actually returned, and last, so that a
    # step which quietly changed the length would change this number with it
    # rather than leaving it describing an earlier version of the take.
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
