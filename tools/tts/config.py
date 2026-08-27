"""Where the speech sidecar's settings live, and why each one is what it is.

The numbers here were arrived at by measuring, not by taste, and the two that
matter are `DEFAULT_STEPS` and the choice to precompute reference latents. Both
have a failure they exist to prevent; see the comments.
"""

import os
from pathlib import Path

from irodori_tts.inference_runtime import RuntimeKey, download_hf_checkpoint

ROOT = Path(__file__).resolve().parents[2]

# Where a voice is made from: `clips/` in, `latents/` out.
#
# `reference/` next to this file is the documented one and it ships in the
# checkout, empty. Drop WAV files into `reference/clips/`, run `make voice`, and
# the latents land beside them. Its own .gitignore keeps the directory tracked
# and the contents out.
#
# The second location is the working tree this was developed in, which keeps its
# reference material with the purchased avatar packages. It is a fallback only,
# so an existing setup does not have to move; a fresh checkout never sees it.
#
# HASHIDATE_VOICE_DIR moves the whole thing elsewhere — including outside the
# repository, which is the right answer for recordings that should not sit in a
# working tree at all. Same shape wherever it points.
#
# None of it is ever tracked. The clips are recordings of a real person and the
# latents are derived from them; `make check-assets` is the backstop.
_CANDIDATES = (Path(__file__).resolve().parent / "reference", ROOT / "backup" / "voice")


def _voice_dir() -> Path:
    override = os.environ.get("HASHIDATE_VOICE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    for candidate in _CANDIDATES:
        if any((candidate / "clips").glob("*.wav")):
            return candidate
    # Nothing to work from yet. Name the documented one, so the error a first
    # run prints points at the directory the instructions talk about.
    return _CANDIDATES[0]


VOICE = _voice_dir()
CLIPS = VOICE / "clips"
LATENTS = VOICE / "latents"

CHECKPOINT = "Aratako/Irodori-TTS-v4.1-Small"
CODEC_REPO = "Aratako/Semantic-DACVAE-Japanese-32dim"

# Apple Silicon runs this at fp32 — the backend has no bf16 — and is fast enough
# that the precision is not worth arguing with. `cpu` is not a fallback anyone
# wants: the same line takes minutes rather than half a second.
DEVICE = "mps"
PRECISION = "fp32"

# Sampling steps, and the one number here that is genuinely tuned.
#
# 8 steps is faster and sounds fine in isolation, but speaker similarity against
# the reference profile collapses from ~0.93 to ~0.74 — close to what the model
# produces with no reference at all. It stops being the same person.
#
# 40 (the upstream default) costs roughly twice the time of 16 and measured
# very slightly *worse*. 16 is the point where quality has arrived and time has
# not yet been wasted.
DEFAULT_STEPS = 16

# Reference loudness target. Matches what the waveform path applies, so a
# precomputed latent stays interchangeable with the clip it came from.
REF_NORMALIZE_DB = -16.0

# Fixed seed by default: a stream that says the same line twice should not get
# two different deliveries for no reason the caller asked for.
DEFAULT_SEED = 1234

# The model generates a whole utterance at once and was trained to a 30-second
# ceiling, so a caller sending a paragraph gets a truncated one. Turns in this
# runtime are single lines, which fits — but the limit is real and belongs where
# a caller can see it.
MAX_SECONDS = 30.0


def runtime_key() -> RuntimeKey:
    return RuntimeKey(
        checkpoint=download_hf_checkpoint(CHECKPOINT),
        model_device=DEVICE,
        codec_repo=CODEC_REPO,
        model_precision=PRECISION,
        codec_device=DEVICE,
        codec_precision=PRECISION,
        codec_deterministic_encode=True,
        codec_deterministic_decode=True,
        compile_model=False,
        compile_dynamic=False,
    )
