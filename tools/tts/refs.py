"""Encode the voice reference clips into latents, once.

The speech model conditions on reference audio, and encoding that audio costs
around 400 ms every time it is handed in as waveforms. The reference does not
change between utterances — it is what makes the voice this character's voice —
so it is encoded ahead of time and loaded instead, which takes about a
millisecond. The generated audio is identical either way.

The room is taken off on the way through — see `repair.py`, which has the
measurements. A latent is where a reference stops being audio, so it is the last
place the recorded room can be removed and the only place worth removing it: a
clean latent makes every line the model ever generates clean, at no per-line
cost.

The clips go in `reference/clips/` and the latents land in `reference/latents/`
beside them; `config.VOICE` resolves both and `HASHIDATE_VOICE_DIR` moves them.
Neither may enter git: the clips are recordings of a real person and the latents
are derived from them.

usage: .venv/bin/python refs.py
"""

import os
import shutil
import tempfile
import uuid
from pathlib import Path

import torch
from irodori_tts.inference_runtime import InferenceRuntime, _load_audio

from config import CLIPS, LATENTS, REF_NORMALIZE_DB, runtime_key
from repair import clean_reference
from vet import describe, vet


def _encode_one(clip: Path, runtime: InferenceRuntime):
    """Encode one clip into the tensor that belongs in the published set."""
    wav, sr = _load_audio(str(clip))
    # The room comes off here rather than on disk. What the model conditions
    # on is this tensor, so cleaning it is enough to keep the recorded room
    # out of every generated line, and the clip stays the recording it was.
    wav = torch.from_numpy(clean_reference(wav.numpy(), int(sr))).to(wav.dtype)
    # The same loudness normalisation the waveform path would have applied,
    # so a precomputed latent is not quietly a different reference from the
    # clip it was made from.
    return runtime.codec.encode_waveform(
        wav.unsqueeze(0),
        sample_rate=int(sr),
        normalize_db=REF_NORMALIZE_DB,
        ensure_max=True,
    ).cpu()


def _publish_latents(staged: Path, destination: Path) -> None:
    """Replace the complete latent set, restoring it on publish error.

    Encoding happens in ``staged`` before this function is called. Moving the
    old directory aside first means a failed second move can put it back, and
    no partially encoded set is ever visible at ``destination``.
    """
    parent = destination.parent
    backup = parent / f".{destination.name}.backup-{uuid.uuid4().hex}"
    old_moved = False
    new_moved = False
    old_exists = os.path.lexists(destination)
    try:
        if old_exists:
            os.replace(destination, backup)
            old_moved = True
        os.replace(staged, destination)
        new_moved = True
    except BaseException:
        # If the new directory made it into place before a later operation
        # failed, remove it before restoring the old complete set.
        if new_moved:
            shutil.rmtree(destination, ignore_errors=True)
        if old_moved:
            os.replace(backup, destination)
        raise
    finally:
        # A failed second move leaves the stage where it was; the caller owns
        # that cleanup. Once the swap succeeds, only the old backup is ours.
        if new_moved and old_moved:
            shutil.rmtree(backup, ignore_errors=True)


def _encode_and_publish(clips: list[Path], runtime: InferenceRuntime) -> None:
    """Encode a complete set, then publish it as one directory swap."""
    LATENTS.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{LATENTS.name}.stage-", dir=LATENTS.parent))
    published = False
    try:
        for clip in clips:
            latent = _encode_one(clip, runtime)
            out = stage / f"{clip.stem}.pt"
            torch.save(latent, out)
            final = LATENTS / out.name
            print(f"{clip.name} -> {final.relative_to(LATENTS.parent)}  {tuple(latent.shape)}")
        _publish_latents(stage, LATENTS)
        published = True
    finally:
        if not published:
            shutil.rmtree(stage, ignore_errors=True)


def main() -> None:
    clips = sorted(CLIPS.glob("*.wav"))
    if not clips:
        raise SystemExit(
            f"no reference clips in {CLIPS}\n"
            "\n"
            "Put a few WAV files of the voice there and run this again. Clean\n"
            "speech, one speaker, no music and no second voice; `make tts-vet`\n"
            "reports on a set without building anything. A handful of clips\n"
            "totalling a minute or two is enough — this is a reference, not a\n"
            "training set.\n"
            "\n"
            "HASHIDATE_VOICE_DIR points all of this somewhere else."
        )
    # Before anything is encoded. A latent cannot be listened to, so this is the
    # last point at which what the voice is made of can still be seen.
    reports = vet(clips)
    print(describe(reports))
    refused = [r.name for r in reports if not r.ok]
    if refused:
        raise SystemExit(
            f"\nrefusing to build latents from {', '.join(refused)}.\n"
            "Take the clip out of the set, or fix it, and run again — a reference "
            "the voice should not have is not something a later setting can undo."
        )

    runtime = InferenceRuntime.from_key(runtime_key())
    _encode_and_publish(clips, runtime)


if __name__ == "__main__":
    main()
