"""Encode the voice reference clips into latents, once.

The speech model conditions on reference audio, and encoding that audio costs
around 400 ms every time it is handed in as waveforms. The reference does not
change between utterances — it is what makes the voice this character's voice —
so it is encoded ahead of time and loaded instead, which takes about a
millisecond. The generated audio is identical either way.

Both the clips and the latents live under `backup/`, with the purchased avatar
packages and for the same reason: they are derived from recordings that are not
ours to redistribute. Nothing here may enter git.

usage: .venv/bin/python refs.py
"""

from pathlib import Path

import torch
from irodori_tts.inference_runtime import InferenceRuntime, _load_audio

from config import CLIPS, LATENTS, REF_NORMALIZE_DB, runtime_key


def main() -> None:
    clips = sorted(CLIPS.glob("*.wav"))
    if not clips:
        raise SystemExit(f"no reference clips in {CLIPS}")
    LATENTS.mkdir(parents=True, exist_ok=True)

    runtime = InferenceRuntime.from_key(runtime_key())
    for clip in clips:
        wav, sr = _load_audio(str(clip))
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
