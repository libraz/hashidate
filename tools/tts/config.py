"""Where the speech sidecar's settings live, and why each one is what it is.

The numbers here were arrived at by measuring, not by taste, and the two that
matter are `DEFAULT_STEPS` and the choice to precompute reference latents. Both
have a failure they exist to prevent; see the comments.
"""

from pathlib import Path

from irodori_tts.inference_runtime import RuntimeKey, download_hf_checkpoint

ROOT = Path(__file__).resolve().parents[2]

# Reference material and everything derived from it. Under `backup/` with the
# purchased avatar packages, on the same rule: not ours to redistribute, never
# tracked. `make check-assets` is the backstop.
VOICE = ROOT / "backup" / "voice"
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
