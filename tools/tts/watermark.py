"""Marking a take as ours, and as synthetic.

Upstream watermarks every take with SilentCipher, carrying its own five-byte
payload. The scheme is kept and the payload is not: what goes out of here is
this project's audio, and the mark on it should say so.

Keeping the scheme is the part that matters. A watermark on synthetic speech is
not decoration — it is the only machine-readable evidence that a clip was
generated rather than recorded, and this voice is cloned from a real person, so
that evidence is worth more here than it would be on a synthetic voice belonging
to nobody. Swapping the payload changes who the mark identifies. Swapping the
scheme, or dropping it, changes whether anyone can tell at all.

## It moves to the end of the pipeline

Upstream embeds the mark immediately after decoding the latent, which puts it
under everything `repair.py` then does. That worked — the payload survived — but
only because the output denoiser was held back to keep it intact.

Embedding last removes the conflict. The denoiser runs at full strength on audio
that carries no mark yet, and the mark is then written into a signal that is
already clean, which is a better outcome for both. Order in `server.py`:

    synthesize -> clean_take -> trim -> mark

## A short line carries a mark nobody can read

Below roughly a second of audio the payload stops decoding — not corrupted, but
absent: the reader reports finding nothing at all. Measured on real speech, 0.7 s
fails and 1.0 s comes back exact, with no partial region in between.

Nothing here can fix that. It is a property of the scheme rather than of this
pipeline, and it applied just as much to the payload upstream was writing.
Padding a short take to reach the threshold is not available either — the viewer
measures the buffer it is handed to drive the mouth, so silence added here to
carry a watermark is silence the mouth would spend moving.

So a one-word turn goes out effectively unmarked, and that is accepted rather
than worked around. A sub-second clip of speech is not the thing a provenance
mark is protecting against.

## Silence is not an acceptable failure here

`claim` replaces a method on an upstream object. If a future version of that
object renames the method, the replacement stops taking effect and upstream's
payload quietly comes back — a wrong answer rather than a loud one. Two things
guard against it: `claim` raises if the method it means to replace is not there,
and `self_test` decodes a real take at startup and refuses to serve unless the
payload that comes back is this one.
"""

import numpy as np
import torch

# "LBRZ1". Five bytes is the whole payload the scheme carries, and every value
# in 0..255 round-trips exactly, so the trailing digit is free to spend on a
# version: a later change of identifier can be told apart from this one rather
# than silently replacing it in the record.
PAYLOAD = (76, 66, 82, 90, 49)

# Below this, the payload does not read back. Not a threshold anything here
# enforces — a shorter take is still marked and still served — but the number
# the startup check has to clear, and the reason its warm-up line is a sentence.
WATERMARK_MIN_SECONDS = 1.0


class WatermarkUnavailable(RuntimeError):
    """The watermarker did not load, so nothing here can be guaranteed."""


def claim(runtime) -> None:
    """Stop the runtime marking takes itself, so this module can do it last.

    Neutralises the batch call rather than the watermarker as a whole. Emptying
    the watermarker would also work and would make upstream log that the audio
    was left unmarked, which would be false and would be the one line in the log
    someone checks when they want to know whether it was.
    """
    watermarker = getattr(runtime, "watermarker", None)
    if watermarker is None or not watermarker.ready:
        raise WatermarkUnavailable(
            "SilentCipher did not load; refusing to serve unmarked audio. "
            "Reinstall the sidecar's dependencies rather than working around this."
        )
    if not hasattr(watermarker, "encode_batch"):
        raise WatermarkUnavailable(
            "the upstream watermarker has no encode_batch to take over; "
            "its marking path has moved and this module has to follow it"
        )
    watermarker.encode_batch = lambda audios, *, sample_rate: audios


def mark(runtime, samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Write the payload into a finished take.

    Length and sample rate come back unchanged, which is load-bearing rather
    than incidental: the duration measured just after this is what the mouth
    runs on, so a step that returned a slightly different number of samples
    would put every viseme track fractionally out for the whole line.
    """
    audio = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32))
    marked = runtime.watermarker.encode_one(audio, sample_rate=sample_rate, payload=PAYLOAD)
    return marked.squeeze().cpu().numpy()


def self_test(runtime, samples: np.ndarray, sample_rate: int) -> None:
    """Mark a real take at startup and read it back, or refuse to start.

    The check is the whole point of doing it on a real take rather than on a
    tone: it exercises the same call the request path uses, against the same
    model, so the thing being proven is that a line served a moment later will
    carry this payload and not another one.

    The take has to be long enough to read back, which is the caller's problem
    and not this function's — a failure here would otherwise be reported as a
    broken watermark when the real answer was a short warm-up line.
    """
    if len(samples) / sample_rate < WATERMARK_MIN_SECONDS:
        raise WatermarkUnavailable(
            f"self-test needs at least {WATERMARK_MIN_SECONDS}s of audio to read a payload "
            f"back, got {len(samples) / sample_rate:.2f}s; lengthen the warm-up line"
        )
    decoded = runtime.watermarker.model.decode_wav(
        mark(runtime, samples, sample_rate), sample_rate, phase_shift_decoding=False
    )
    messages = decoded.get("messages") or []
    found = tuple(messages[0]) if messages else ()
    if not decoded.get("status") or found != PAYLOAD:
        raise WatermarkUnavailable(
            f"watermark self-test failed: expected {PAYLOAD}, read back {found or 'nothing'}"
        )
