"""Making a take what the renderer expects: no room, no dead air.

Three problems, three functions. The first two remove noise from opposite ends
of the model; the third cleans up after them.

## The noise has three sources and needs three treatments

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

**And the room made sounds.** Both passes above estimate a *steady* noise and
subtract it, so neither one touches a door closing or a chair moving. Those
survive the cleaning intact while the bed that was covering them drops 20-25 dB,
which leaves them more audible in the finished voice than they were in the
recording — the one thing here that made the problem worse before it made it
better. A highpass on the reference removes the class of them that carries no
speech-band energy; the numbers, and what it does not reach, are at
`REFERENCE_HPF_HZ`.

## A take can end after the line is already over

The model is given a duration before it is given a chance to fill it, and when
that prediction is long the surplus does not come back as silence — it comes
back as more speech. Measured on four lines at the shipped settings, three of
them carry a fragment after the line has finished and gone quiet:

    line                      line ends   silence   fragment   last 50 ms
    ...ひととおり説明します。      5.40 s     1.00 s      none      -78.6 dBFS
    ...角度で指定します。          5.42 s     0.66 s    to the end  -41.4 dBFS
    ...顔が面に見えるとか。        8.46 s     0.62 s    to the end  -11.6 dBFS
    ...見てくれて、ありがとう。     4.08 s     0.68 s    to the end   -9.2 dBFS

The fragment is not the end of the line — there is two thirds of a second of
true floor between the two — and it does not finish, because the buffer runs out
first. A take that stops on a voiced vowel at -9 dBFS is a step, and a step is a
knock; through the viewer's room it is a knock with a tail on it.

`duration_scale` does not fix it at source: at 0.80 one line still ends at -26.1
dBFS while another loses a fifth of its voiced material, and no value tried was
clean across all four. `SamplingRequest.trim_tail` makes no difference at all —
on and off produce the same samples. So it is dealt with here, by `close_tail`.

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

from libsonare import (
    StreamingEqualizer,
    mastering_repair_denoise_classical,
    mastering_repair_trim_silence,
)

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

# Where the reference stops being the speaker and starts being the room.
#
# The denoiser above removes a *steady* bed and nothing else, which is what it
# is for and also its limit. Measured across the four clips, cleaning drops the
# median level of a pause by 20-25 dB and moves the loudest frame in that same
# pause by at most 1.4 dB:
#
#     bright-01  70-100 Hz   pause median -17.5 -> -37.9   pause max -7.9 -> -7.9
#     calm-01    70-100 Hz   pause median -19.6 -> -44.2   pause max -14.2 -> -12.8
#
# What does not move is what is not steady — a door, a chair, a footstep. So
# cleaning alone leaves those 20-25 dB further above their surroundings than
# they were in the recording, and the model clones the result: generated lines
# carried isolated bursts 200-400 ms clear of any speech with essentially all
# their energy under 120 Hz, at -33 to -40 dBFS.
#
# A level gate cannot separate them, which was tried: at -30 dBFS they sit in
# the same range as a quiet syllable. Frequency can. The set's medians span
# 295-392 Hz, so nothing below 120 Hz is the speaker at all, and removing it
# took those bursts to -50 to -80 dBFS while the 250 Hz - 4 kHz level of the
# speech itself moved by +1 to +4 dB — up, not down.
#
# Two biquads at the Butterworth Q pair — 24 dB/octave — run forward and then
# backward, which doubles that to 48 and cancels the phase shift: -0.0 dB at
# 250 Hz, -0.4 at 180, -6.0 at the corner, -27.5 at 80. It removes a class of
# noise rather than all of it — bursts with energy in the speech band are still
# there and still need somebody to listen for them, which is the same gap
# `vet.py` describes.
REFERENCE_HPF_HZ = 120.0
REFERENCE_HPF_Q = (0.5412, 1.3066)
_HPF_BLOCK = 4096

# What a severed take looks like, and how far back to cut it.
#
# A take that finished ends on its own decay. One that ran out of buffer ends
# wherever it happened to be, and the level of the last few milliseconds is what
# separates the two: -78.6 dBFS for the line that finished against -41.4, -11.6
# and -9.2 for the three that did not. -55 sits in the gap with room on both
# sides, and nothing at -55 dBFS is a step anybody hears.
TAIL_SEVERED_DBFS = -55.0
TAIL_MEASURE_MS = 50.0

# The grid the tail is read on. Short enough to land a cut inside a pause rather
# than near one, long enough that a single glottal period does not read as a
# frame of speech at this speaker's pitch.
FRAME_MS = 20.0

# How long the floor has to hold to count as a pause at all.
#
# Not "long enough to be the end of the line" — it cannot be. A line's own
# interior pauses run as long as anything at its end: the four takes measured
# carry interior silences of 0.40, 0.38 and 0.64 s against terminal gaps of
# 0.44, 0.56 and 0.70. Length does not separate them and nothing here pretends
# it does; `close_tail` is gated on the take being severed, and only then looks
# backwards. All this threshold has to do is tell a pause from the closure
# inside a consonant, and those measured 0.14 s and under.
TAIL_GAP_MS = 250.0

# And how much material may follow that pause and still be surplus rather than
# the line. The three severed fragments measured 0.06, 0.20 and 0.22 s, so this
# is roughly double the largest of them.
#
# The risk this bounds is real and worth stating: a take whose *own* closing
# phrase was cut off, and which happens to have a pause in front of it, loses
# that phrase here instead of keeping a broken version of it. Nothing in the
# audio distinguishes the two cases — the model does not say which of the sounds
# it made it meant. Keeping the window tight is what makes that rare, and it is
# a trade rather than a solution.
TAIL_FRAGMENT_MS = 400.0

# When a take is severed and there is no floor to cut back to, the line itself
# was cut and there is nothing to recover. Fading is not a repair, it is the
# difference between a truncated word and a truncated word with a click on it.
TAIL_FADE_MS = 15.0


def _highpass_once(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """One pass of the cascade, in block-sized pieces because the EQ is streaming."""
    eq = StreamingEqualizer(sample_rate, _HPF_BLOCK)
    for index, q in enumerate(REFERENCE_HPF_Q):
        # Every key here is load-bearing: `set_band` accepts a dictionary it does
        # not recognise without complaining and leaves the band at its defaults,
        # so a misspelling is a filter that silently passes everything. Checked
        # by measuring the response rather than by the call not raising.
        eq.set_band(
            index,
            {"type": "highPass", "frequencyHz": REFERENCE_HPF_HZ, "q": q, "enabled": True},
        )
    blocks = [
        np.asarray(
            eq.process_mono(np.ascontiguousarray(samples[i : i + _HPF_BLOCK], dtype=np.float32)),
            dtype=np.float32,
        )
        for i in range(0, len(samples), _HPF_BLOCK)
    ]
    return np.concatenate(blocks) if blocks else samples


def _highpass(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Take everything below the speaker off, without moving anything in time."""
    forward = _highpass_once(samples, sample_rate)
    return np.ascontiguousarray(_highpass_once(forward[::-1].copy(), sample_rate)[::-1])


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

    Two passes, and the order is the one that was measured. The denoiser runs
    first, on the recording as it stands: `N_FFT` is what it is because the low
    rumble dominates the bed and a shorter window reads it as signal, so taking
    that rumble away beforehand would undermine the reason the window is 2048.
    The highpass then removes what a steady-noise estimator cannot — see
    `REFERENCE_HPF_HZ`.
    """
    denoised = mastering_repair_denoise_classical(
        np.ascontiguousarray(samples, dtype=np.float32),
        sample_rate,
        mode="logMmse",
        noise_estimator="imcra",
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
    )
    return _highpass(denoised, sample_rate)


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


def close_tail(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """End a take on a decay rather than on a step.

    Runs before `trim`, not after. What this leaves behind is the pause it cut
    back to, and trimming is the thing that knows how to take a pause off an
    end — doing it in the other order would mean measuring the same silence
    twice and cutting it once.

    Three outcomes, and the first is the common one:

    - the take already ends quietly, and is returned untouched;
    - it was severed, and there is a pause to cut back to, so the surplus goes;
    - it was severed with no pause behind it, which means the line itself was
      cut and there is nothing to recover, so the edge is faded instead.

    The thresholds and what they are measured against are above.
    """
    frame = int(sample_rate * FRAME_MS / 1000.0)
    if frame <= 0 or len(samples) < frame * 2:
        return samples

    tail = samples[-int(sample_rate * TAIL_MEASURE_MS / 1000.0) :]
    if 20.0 * np.log10(np.sqrt((tail.astype(np.float64) ** 2).mean()) + 1e-20) <= TAIL_SEVERED_DBFS:
        return samples

    count = len(samples) // frame
    energy = samples[: count * frame].reshape(-1, frame).astype(np.float64)
    level = 20.0 * np.log10(np.sqrt((energy**2).mean(axis=1)) + 1e-20)
    quiet = level <= TAIL_SEVERED_DBFS

    need = max(1, int(TAIL_GAP_MS / FRAME_MS))
    limit = int(TAIL_FRAGMENT_MS / FRAME_MS)
    # Walk back from the end over the fragment, looking for the pause behind it.
    run = 0
    for index in range(count - 1, max(-1, count - 1 - limit - need), -1):
        if quiet[index]:
            run += 1
            if run >= need:
                return np.ascontiguousarray(samples[: (index + need) * frame])
        else:
            run = 0

    fade = min(int(sample_rate * TAIL_FADE_MS / 1000.0), len(samples))
    out = samples.copy()
    out[len(out) - fade :] *= np.linspace(1.0, 0.0, fade, dtype=samples.dtype)
    return out


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
