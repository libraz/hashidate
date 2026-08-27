"""Checking a reference clip before it becomes the voice.

A reference is not an input, it is the definition of the character. Everything
the model generates is an attempt to sound like these files, so anything in one
of them — a second speaker, a clipped peak, a room — is not noise on the way in,
it is a property of the voice from then on. And it is invisible after the fact:
what comes out is a latent, and a latent cannot be listened to.

That is the failure this module exists to prevent. It ran once with nobody
having measured what was in the clips, and diagnosing a complaint about the
*output* meant working backwards through a pipeline to material that should have
been characterised on the way in.

## What is refused, and what is only reported

Refused, because the voice is wrong from then on and no downstream setting
recovers it:

- **The wrong person.** Pitch outside the range the rest of the set occupies,
  measured only on frames loud enough to carry a real pitch, and judged against
  the *set* rather than against an absolute idea of what a voice sounds like.
- **Clipping.** A flattened peak is distortion the model will faithfully learn
  to reproduce.
- **Too short to characterise.** Under a few seconds there is not enough voiced
  material for the encoder to average over.

Reported but allowed, because `repair.clean_reference` deals with it and the
number is worth seeing anyway:

- **The noise floor.** A quiet room is better than a loud one, but a loud one is
  survivable and the cleaning is measured against exactly this figure.

## What this does NOT catch, stated because the gap is easy to assume away

**A voice talking quietly in the background is invisible here.** The pitch
tracker follows whichever voice is loudest, so a second speaker that never
becomes the loudest never enters the measurement at all. This is not a threshold
that could be lowered — it is what single-pitch tracking is. Checked rather than
assumed: a synthetic 120 Hz voice mixed under a clip at -30 dB passes every test
below without moving a single figure, while the same clip pitched down an octave
— a different *dominant* voice — is refused twice over.

So the gate answers "is this the right person, cleanly recorded", and does not
answer "is there anything else in the room". The second question still needs
somebody to listen.

## The thresholds are set from the set, not from a standard

There is no absolute right answer for what pitch a character has. What can be
said is that four clips of one person should agree with each other, so the
consistency check is against the set's own median. A set of one is therefore
unvettable for consistency, and says so rather than passing silently.
"""

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf
from libsonare import pitch_pyin

# Pitch search bounds. Wide enough to see a man and a child on either side of
# the target, because the point is to notice one, not to assume there isn't one.
F0_MIN_HZ = 65.0
F0_MAX_HZ = 600.0

# Only frames within this much of the clip's loudest count toward a pitch
# figure. Without it the tracker rails against its own lower bound in near
# silence and reports a 60 Hz voice that is not there — which is exactly the
# false alarm that sent the first investigation of this after the wrong file.
PITCH_FLOOR_DB = 25.0

# How close to a search bound a reported pitch may come before it is treated as
# the tracker giving up rather than answering. 5% of 65 Hz is about 3 Hz, which
# is wider than any real pitch sits from the bound and narrower than the gap to
# anything a person actually says. See `_pitch`.
RAIL_MARGIN = 0.05

# How far one clip's median pitch may sit from the set's before it is treated as
# a different person. Generous: the current set spans 295 to 392 Hz, which is a
# real spread for one speaker reading in different moods.
CONSISTENCY_TOLERANCE = 0.45

# Voiced frames allowed below the set's own range before the clip is treated as
# somebody else. Not zero, because one creaky syllable should not fail a good
# clip; the real set sits at 0.0% except for one clip at 1.4%, and an octave-
# shifted control reaches 83%, so there is a great deal of room between the two.
INTRUDER_FRACTION = 0.03

# Peak headroom. A clip that reaches full scale has probably already lost
# something to the limiter that put it there.
PEAK_CEILING_DB = -0.1

MIN_SECONDS = 3.0


@dataclass
class Report:
    name: str
    seconds: float
    sample_rate: int
    peak_db: float
    noise_floor_db: float
    median_f0: float
    low_f0_fraction: float
    voiced_frames: int
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def _pitch(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Every pitch this clip actually carries, in Hz, loud frames only.

    Two filters, and both were put here by a false positive rather than by
    theory.

    The energy gate came first: without it the tracker reports a pitch for
    near-silence, and a clip's quiet moments turn into a deep voice that is not
    there. The rail filter came second and is the more important of the two. A
    value sitting exactly on `F0_MIN_HZ` is not a low measurement, it is the
    tracker failing to measure and returning the edge of its own search — on the
    clip that prompted this module, 145 of the 149 supposedly-deep frames were
    at the bound to three decimal places. Keeping them accuses a clean recording
    of harbouring a second speaker, which is precisely the mistake this file
    exists to stop somebody else making.
    """
    pitch = pitch_pyin(samples, sample_rate, fmin=F0_MIN_HZ, fmax=F0_MAX_HZ)
    f0 = np.asarray(pitch.f0, dtype=np.float64)
    voiced = np.asarray(pitch.voiced_flag, dtype=bool)
    hop = len(samples) / max(1, len(f0))
    energy = np.array(
        [
            np.sqrt(
                (samples[int(i * hop) : int((i + 1) * hop)].astype(np.float64) ** 2).mean() + 1e-20
            )
            for i in range(len(f0))
        ]
    )
    energy_db = 20.0 * np.log10(energy)
    loud = energy_db > energy_db.max() - PITCH_FLOOR_DB
    railed = (f0 < F0_MIN_HZ * (1.0 + RAIL_MARGIN)) | (f0 > F0_MAX_HZ * (1.0 - RAIL_MARGIN))
    return f0[voiced & np.isfinite(f0) & (f0 > 0) & loud & ~railed]


def _measure(path: Path) -> tuple[Report, np.ndarray]:
    audio, sample_rate = sf.read(path, always_2d=True)
    samples = np.asarray(audio[:, 0], dtype=np.float32)
    seconds = len(samples) / sample_rate

    peak_db = 20.0 * np.log10(float(np.abs(samples).max()) + 1e-20)

    window = int(sample_rate * 0.02)
    usable = len(samples) // window * window
    frames = samples[:usable].reshape(-1, window).astype(np.float64)
    level = 20.0 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-20)
    quiet = level < level.max() - 35.0
    noise_floor = float(np.median(level[quiet])) if quiet.any() else float("nan")

    values = _pitch(samples, int(sample_rate))

    return (
        Report(
            name=path.name,
            seconds=seconds,
            sample_rate=int(sample_rate),
            peak_db=peak_db,
            noise_floor_db=noise_floor,
            median_f0=float(np.median(values)) if len(values) else float("nan"),
            low_f0_fraction=0.0,
            voiced_frames=int(len(values)),
            failures=[],
            notes=[],
        ),
        values,
    )


def vet(paths: list[Path]) -> list[Report]:
    """Measure every clip, then judge each against the others.

    Two passes and not one, because the interesting checks are relative. A clip
    can only be the odd one out once there is something to be odd against.
    """
    measured = [_measure(p) for p in paths]
    reports = [r for r, _ in measured]

    for report in reports:
        if report.seconds < MIN_SECONDS:
            report.failures.append(f"only {report.seconds:.1f}s; need {MIN_SECONDS:.0f}s of material")
        if report.peak_db > PEAK_CEILING_DB:
            report.failures.append(f"peaks at {report.peak_db:+.1f} dBFS, so it may already be clipped")
        if report.voiced_frames < 20:
            report.failures.append(f"only {report.voiced_frames} usable voiced frames; is anyone speaking?")
        if not np.isnan(report.noise_floor_db) and report.noise_floor_db > -35.0:
            report.notes.append(f"noisy room at {report.noise_floor_db:.1f} dBFS; the cleaning will work harder")

    medians = [r.median_f0 for r in reports if not np.isnan(r.median_f0)]
    if len(medians) < 2:
        for report in reports:
            report.notes.append("a set of one cannot be checked for consistency")
        return reports

    set_median = float(np.median(medians))
    for report in reports:
        if np.isnan(report.median_f0):
            continue
        drift = abs(report.median_f0 - set_median) / set_median
        if drift > CONSISTENCY_TOLERANCE:
            report.failures.append(
                f"median pitch {report.median_f0:.0f} Hz against the set's {set_median:.0f} Hz "
                "— this does not sound like the same person as the rest"
            )

    # The wrong person also shows up as voiced frames well under where this set
    # lives — a second signal for the same fault as the median check above, kept
    # because a clip can drag its median only partway while still being someone
    # else for half its length. It says nothing about a quiet background voice;
    # see the module docstring.
    intruder_ceiling = set_median * 0.55
    for report, values in measured:
        if len(values) == 0:
            continue
        fraction = float((values < intruder_ceiling).mean())
        report.low_f0_fraction = fraction
        if fraction > INTRUDER_FRACTION:
            report.failures.append(
                f"{100 * fraction:.1f}% of voiced frames sit below {intruder_ceiling:.0f} Hz "
                "— the voice carrying this clip is not the one carrying the others"
            )

    return reports


def describe(reports: list[Report]) -> str:
    """One line per clip, in the order they were given."""
    lines = [
        f"{'clip':16s} {'length':>7s} {'peak':>7s} {'floor':>7s} {'pitch':>7s} {'low':>6s}  verdict",
    ]
    for r in reports:
        verdict = "ok" if r.ok else "REFUSED"
        lines.append(
            f"{r.name:16s} {r.seconds:6.2f}s {r.peak_db:+6.1f} {r.noise_floor_db:7.1f} "
            f"{r.median_f0:6.0f}Hz {100 * r.low_f0_fraction:5.1f}%  {verdict}"
        )
        for failure in r.failures:
            lines.append(f"{'':16s} ! {failure}")
        for note in r.notes:
            lines.append(f"{'':16s} - {note}")
    return "\n".join(lines)


def main() -> None:
    """Check the clip set without building anything from it.

    `refs.py` runs the same check before encoding, so this is for the moment
    before that: dropping a new recording in and finding out whether it belongs
    in the set, without spending a model load to hear the answer.
    """
    import sys

    from config import CLIPS

    paths = [Path(a) for a in sys.argv[1:]] or sorted(CLIPS.glob("*.wav"))
    if not paths:
        raise SystemExit(f"no clips in {CLIPS}")
    reports = vet(paths)
    print(describe(reports))
    refused = [r.name for r in reports if not r.ok]
    if refused:
        raise SystemExit(f"\n{len(refused)} of {len(reports)} would be refused: {', '.join(refused)}")
    print(f"\nall {len(reports)} clips usable. Nothing here can tell you whether")
    print("something else is audible in the background — that still needs a listen.")


if __name__ == "__main__":
    main()
