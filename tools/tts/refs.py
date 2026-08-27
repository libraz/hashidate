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

from pathlib import Path

import torch
from irodori_tts.inference_runtime import InferenceRuntime, _load_audio

from config import CLIPS, LATENTS, REF_NORMALIZE_DB, runtime_key
from repair import clean_reference
from vet import describe, vet


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

    LATENTS.mkdir(parents=True, exist_ok=True)

    runtime = InferenceRuntime.from_key(runtime_key())
    for clip in clips:
        wav, sr = _load_audio(str(clip))
        # The room comes off here rather than on disk. What the model conditions
        # on is this tensor, so cleaning it is enough to keep the recorded room
        # out of every generated line, and the clip stays the recording it was.
        wav = torch.from_numpy(clean_reference(wav.numpy(), int(sr))).to(wav.dtype)
        # The same loudness normalisation the waveform path would have applied,
        # so a precomputed latent is not quietly a different reference from the
        # clip it was made from.
        latent = runtime.codec.encode_waveform(
            wav.unsqueeze(0),
            sample_rate=int(sr),
            normalize_db=REF_NORMALIZE_DB,
            ensure_max=True,
        ).cpu()
        out = LATENTS / f"{clip.stem}.pt"
        torch.save(latent, out)
        print(f"{clip.name} -> {out.relative_to(LATENTS.parent)}  {tuple(latent.shape)}")


if __name__ == "__main__":
    main()
