"""Speech for the avatar, as a local service.

The renderer needs two things from a voice: the audio to play, and how long it
actually lasts. The mouth layer estimates the second from text when it has to,
but an estimate drifts against real speech — so this returns the audio and the
measured duration together, and the caller drives the mouth off the measurement.

    orchestrator ──POST /speak──► this ──wav + X-Speech-Seconds──► viewer

**Binds a UNIX socket, on a stronger form of the licence condition that governs
the control API.** The voice is cloned from recordings that are not ours to
republish, which is a stronger reason than the avatar's, not a weaker one — and
the only caller is the control server on this machine, which proxies for the
renderer. A loopback port would be reachable by every process and every user
here; the socket sits in a directory this user owns, mode 0700, so nobody else
can reach the path at all. Putting the voice back on a port and adding a CORS
header to it is a licensing decision before it is a code change.

The model is loaded once and stays resident: loading costs about sixteen
seconds, and a process that pays that per line is not a voice, it is a batch
job. Generation is not streamed — this architecture produces a whole utterance
at once — so the time to the first sample is the time to the last one. At the
default step count that is roughly half a second for a normal line, which is
why the caller is expected to send one line at a time rather than a paragraph.

usage: .venv/bin/python server.py [--uds .run/speech.sock]
"""

import argparse
import errno
import io
import os
import signal
import socket
import stat
import threading
import time
import traceback
from contextlib import asynccontextmanager, suppress
from pathlib import Path

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
    MODEL,
    REF_NORMALIZE_DB,
    runtime_key,
)
import watermark
from repair import clean_take, close_tail, trim

# Where the socket goes, matching `SOCKET_DIR`/`SOCKET_NAME` in
# src/speech/sidecar.ts. Neither side is told by the other: the control server
# and this one are separate commands, so each works the path out from where its
# own source file is. Beside the sidecar rather than in a temporary directory,
# so that two checkouts running at once get two sockets without arranging it.
#
# The directory is the permission boundary and is made 0700 below. macOS
# honours the mode on the socket file too, but the directory is what makes that
# a detail rather than the whole defence.
SOCKET_DIR = Path(__file__).resolve().parent / ".run"
SOCKET_NAME = "speech.sock"

# A UNIX socket path is copied into a fixed-size field in the kernel — 104 bytes
# on this platform, and the failure at bind names none of that. A checkout deep
# enough to overflow it is unusual and worth saying plainly, because the answer
# is to put the socket somewhere else rather than to move the checkout.
SOCKET_PATH_MAX = 100

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
_startup_error: Exception | None = None


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


def _stop_serving() -> None:
    """Ask this process to shut down the way a terminal interrupt would."""
    os.kill(os.getpid(), signal.SIGTERM)


def _load_model() -> None:
    """
    Bring the model in, off the thread that serves requests.

    It runs beside the server rather than ahead of it, so the socket answers
    `/health` with `ready: false` for the whole load instead of leaving callers
    waiting in the listen backlog. `_runtime` is published last, which is what
    makes ready mean that marking has been proven on a real take. A failure
    stops the process: a sidecar that is up but can never become ready is the
    one state worse than none.
    """
    global _runtime, _latents, _startup_error
    try:
        latents = sorted(str(p) for p in LATENTS.glob("*.pt"))
        if not latents:
            raise RuntimeError(f"no reference latents in {LATENTS}; run refs.py first")
        runtime = InferenceRuntime.from_key(runtime_key())
        # Before anything is generated: the runtime marks takes on the way out of
        # the decoder, and `speak` needs to mark them at the end instead.
        watermark.claim(runtime)
        # One synthesis so the first real line does not pay for the backend
        # compiling its kernels — which it otherwise does, visibly, mid-sentence.
        #
        # A sentence rather than a word, because this take is also what the
        # watermark is checked against and the payload needs about a second of audio
        # to be readable back. See `watermark.WATERMARK_MIN_SECONDS`.
        warmup = runtime.synthesize(
            SamplingRequest(
                text="音声の準備をしています。",
                ref_latents=latents,
                num_steps=DEFAULT_STEPS,
                seed=DEFAULT_SEED,
            )
        )
        # And it doubles as the proof that marking works, on the real path rather
        # than on a tone. A failure here stops the sidecar: audio that goes out
        # carrying the wrong payload, or none, is worse than no audio at all.
        watermark.self_test(
            runtime, warmup.audio.squeeze().cpu().numpy(), int(warmup.sample_rate)
        )
    except Exception as error:
        _startup_error = error
        traceback.print_exc()
        _stop_serving()
        return
    _latents = latents
    _runtime = runtime
    print(f"speech ready on {DEVICE}: {MODEL} model, {len(latents)} reference latents", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=_load_model, name="speech-load", daemon=True).start()
    yield


app = FastAPI(title="hashidate speech", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ready": _runtime is not None,
        "device": DEVICE,
        "model": MODEL,
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


def endpoint(args: argparse.Namespace) -> Path:
    """
    Where to bind the private socket.

    The same order as `speechEndpoint` in src/speech/sidecar.ts for the bundled
    sidecar. The control server may still point at an external HTTP synthesiser,
    but this process never opens a TCP listener, even when a port variable is
    present in its environment.
    """
    if args.uds is not None:
        return args.uds.expanduser().resolve()
    override = os.environ.get("HASHIDATE_TTS_SOCKET", "")
    if override:
        return Path(override).expanduser().resolve()
    return SOCKET_DIR / SOCKET_NAME


def clear_stale(path: Path) -> None:
    """
    Drop a socket file that nothing is behind.

    A sidecar killed rather than stopped leaves its path in the filesystem, and
    a bind onto that fails with "address already in use" — which is true of the
    file and false of the service, and is the one startup failure here that
    reads as somebody else's fault. Connecting is the only way to tell the two
    apart, so it is asked rather than assumed: a refused connection means the
    file is a leftover, and a successful one means there is a voice here
    already and this process has nothing to add.
    """
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    except OSError:
        raise SystemExit(f"HASHIDATE_TTS_SOCKET path cannot be inspected: {path}") from None
    if not stat.S_ISSOCK(mode):
        raise SystemExit(f"HASHIDATE_TTS_SOCKET path is not a UNIX socket: {path}")

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(str(path))
    except OSError as error:
        if error.errno == errno.ENOENT:
            return
        if error.errno != errno.ECONNREFUSED:
            raise SystemExit(f"HASHIDATE_TTS_SOCKET path cannot be probed: {path}") from None
        try:
            # Re-check after probing so a path replaced while connect() was in
            # flight is never unlinked merely because the old node was a socket.
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise SystemExit(f"HASHIDATE_TTS_SOCKET path is not a UNIX socket: {path}")
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            raise SystemExit(f"HASHIDATE_TTS_SOCKET stale path cannot be removed: {path}") from None
        return
    finally:
        probe.close()
    raise SystemExit(f"HASHIDATE_TTS_SOCKET path is already in use: {path}")


def _socket_parent(path: Path) -> None:
    """Create private parents, or validate an existing private parent."""
    parent = path.parent
    missing: list[Path] = []
    current = parent
    while True:
        try:
            info = current.lstat()
        except FileNotFoundError:
            missing.append(current)
            if current.parent == current:
                break
            current = current.parent
            continue
        except OSError:
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent cannot be inspected: {path}"
            ) from None
        if not stat.S_ISDIR(info.st_mode):
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent is not a directory: {path}"
            ) from None
        break

    created: set[Path] = set()
    for directory in reversed(missing):
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            # Another process won a creation race. It is treated as existing,
            # and therefore must pass the same private-directory check below.
            pass
        except OSError:
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent cannot be created: {path}"
            ) from None
        else:
            created.add(directory)

    for directory in missing or [parent]:
        try:
            info = directory.lstat()
        except OSError:
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent is inaccessible: {path}"
            ) from None
        if not stat.S_ISDIR(info.st_mode):
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent is not a directory: {path}"
            ) from None
        if directory in created:
            try:
                directory.chmod(0o700)
            except OSError:
                raise SystemExit(
                    f"HASHIDATE_TTS_SOCKET path parent cannot be secured: {path}"
                ) from None
            continue
        if stat.S_IMODE(info.st_mode) != 0o700 or not os.access(
            directory, os.R_OK | os.W_OK | os.X_OK
        ):
            raise SystemExit(
                f"HASHIDATE_TTS_SOCKET path parent is not a private accessible directory: {path}"
            ) from None


def listen(path: Path) -> socket.socket:
    """Bind the socket this process owns, and nobody else can reach."""
    if len(str(path).encode()) > SOCKET_PATH_MAX:
        raise SystemExit(
            f"the socket path is too long for the kernel to hold ({path}); "
            "set HASHIDATE_TTS_SOCKET to a shorter one"
        )
    _socket_parent(path)
    clear_stale(path)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(path))
    # Before anything is listening on it, so there is no window in which the
    # socket exists and is open to the machine. uvicorn would set 0o666 here if
    # it were binding this itself, which is why it is handed a socket instead.
    path.chmod(0o600)
    sock.listen(16)
    return sock


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uds", type=Path, default=None, help="socket path to bind")
    return parser


def main() -> None:
    where = endpoint(argument_parser().parse_args())

    sock = listen(where)
    print(f"speech listening at {where}", flush=True)
    try:
        uvicorn.run(app, fd=sock.fileno(), log_level="warning")
    finally:
        # uvicorn removes a socket it bound itself; this one it was handed, and
        # it works on a duplicate of the descriptor — so both ends are closed
        # here, quietly. A stop is not the moment for a traceback about which
        # of the two got there first.
        with suppress(OSError):
            sock.close()
        where.unlink(missing_ok=True)
    if _startup_error is not None:
        raise SystemExit(f"speech failed to start: {_startup_error}")


if __name__ == "__main__":
    main()
