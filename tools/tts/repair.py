"""Making a take what the renderer expects: no room, no dead air.

Two problems, three functions. The first two remove noise from opposite ends of
the model; the third cleans up after them.

## The noise has two sources and needs two treatments

**The references carry a room.** `calm-01` and `calm-02` sit on a steady bed at
-43.1 and -44.3 dBFS that varies by only 2 dB frame to frame — a constant, an
air conditioner or a preamp rather than anything the speaker did. The model
clones a reference faithfully, so it clones that too: a generated line's pauses
measured -45.5 dBFS with the same stability and the same spectral tilt as the
clips they came from. That is the larger half of the problem and it is already
present before the model runs.

**The codec adds its own floor.** Cleaning the references moves the generated
bed to -62.7 dBFS but leaves 3-14 kHz where it was, and what remains there is
white rather than coloured — the room tone had a tilt, this does not. It arrives
after the reference is out of the picture, so it can only be taken off the
output. Pause bed and speech-to-noise on the same line, measured four ways:

    as they arrive       -45.5 dBFS   32.5 dB
    references cleaned   -62.7 dBFS   50.3 dB
    take cleaned         -60.0 dBFS   46.9 dB
    both                 -62.9 dBFS   50.4 dB

## Cleaning the references makes the model pause differently

Not a side effect of the filter — a different reference is a different
conditioning signal, and the model answers it with a different delivery. On the
line above it left 0.68 s of lead-in and 1.26 s of trailing silence where the
original had 0.14 s and none.

That is nearly two seconds of nothing in a six-second take, and it matters more
than it sounds: the viseme track is stretched onto the take's measured length,
so silence on the ends is silence the mouth spends moving. Trimming is what
makes `seconds` mean the length of the voice again rather than the length of the
file, which is what the mouth needed it to mean all along.

## Nothing here runs over the watermark

Every take carries one — see `watermark.py` — and a denoiser is exactly the kind
of thing that would damage it, since the mark sits some 50 dB under the speech,
which is where the noise being removed also lives. Rather than hold the
denoiser back to spare it, the marking is done afterwards, on audio these
functions have already finished with. Both passes below therefore run at full
strength, and neither has a setting that exists to protect anything.

The order that makes that true is in `server.py`, and it is the only order that
works: clean, trim, then mark.
"""

import numpy as np

from libsonare import mastering_repair_denoise_classical, mastering_repair_trim_silence

# STFT geometry, shared by both denoising passes.
#
# 2048 at 48 kHz is a 43 ms window, long enough to resolve the low rumble that
# dominates the reference bed — a 1024 window leaves it smeared across three
# bins and the estimator reads it as signal. The 4x overlap is what keeps the
# gain changes from becoming an artefact of their own.
N_FFT = 2048
HOP_LENGTH = 512

# What counts as silence when trimming, and how much to leave.
#
# Gated by loudness over a window rather than by sample peak, and that is not a
# preference. Every take carries a single-sample transient at index 0 — about
# -52 dBFS, present in the raw model output and not something the cleaning
# introduced — and a peak trimmer finds it, concludes the take starts at sample
# zero, and removes nothing from the front. A window asks whether a *region* is
# silent, which is the question actually being asked.
#
# 200 ms and -60 LUFS, measured against where the voice really starts: on a line
# whose speech occupies 0.620..5.380 s, this cuts 0.510 s and 0.651 s, so it
# stops 110 ms short of the first mora. A 100 ms window trims 50 ms more and
# leaves only 61 ms of margin, which is too little to hold across lines that end
# on a fading vowel. Nothing at -60 LUFS is audible either way.
#
# The padding matters for the same reason: cutting flush to the gate clips the
# attack off the opening mora, which reads as a bad edit rather than a tight one.
TRIM_GATE_LUFS = -60.0
TRIM_WINDOW_MS = 200.0
TRIM_PADDING_MS = 30.0


def clean_reference(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Take the room off a reference clip, before it is encoded to a latent.

    IMCRA rather than the quantile estimator, because a real recording's noise
    moves — a room over eight seconds is not one level — and IMCRA tracks it
    where the quantile estimator assumes a fixed noise-only fraction and picks
    one number for the whole clip.

    Measured on `calm-01`: floor -43.1 -> -58.7 dBFS, with the loud frames
    moving by -0.64 dB. That gap is the whole argument for doing this at all. A
    narrower one would mean the voice was going out with the room.

    The clips themselves are never written back. They are the licensed source
    material and this is a derivation, on the same footing as the latent it
    feeds, so a clip on disk stays the recording it was and rerunning `refs.py`
    reproduces the cleaning from scratch.
    """
    return mastering_repair_denoise_classical(
        np.ascontiguousarray(samples, dtype=np.float32),
        sample_rate,
        mode="logMmse",
        noise_estimator="imcra",
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
    )


def clean_take(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Take the codec's floor off a generated line, on the way out.

    The quantile estimator here and not IMCRA, for the same reason IMCRA was
    chosen above: a synthesised line's noise does not drift, and its pauses are
    genuinely noise-only, which is exactly what the quantile estimator assumes.
    Measured with it the loud frames do not move at all — -13.4 dBFS before and
    after — where IMCRA cost them 0.9 dB for no further reduction.
    """
    return mastering_repair_denoise_classical(
        np.ascontiguousarray(samples, dtype=np.float32),
        sample_rate,
        mode="logMmse",
        noise_estimator="quantile",
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
    )


def trim(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Cut the dead air off both ends, so the take is as long as the voice.

    Only the ends. A pause inside a line is the delivery and belongs to the
    speaker; a pause before the first mora is the model clearing its throat and
    belongs to nobody. The mouth is what this is for — see the module docstring.

    Runs after denoising, not before. The threshold below is meaningful only
    once the ends are actually quiet, and on an unprocessed take they sit on the
    reference's room tone at -43 dBFS, which is far too loud to trim against.
    """
    return mastering_repair_trim_silence(
        np.ascontiguousarray(samples, dtype=np.float32),
        sample_rate,
        mode="lufs",
        gate_lufs=TRIM_GATE_LUFS,
        window_ms=TRIM_WINDOW_MS,
        padding_samples=int(sample_rate * TRIM_PADDING_MS / 1000.0),
    )
