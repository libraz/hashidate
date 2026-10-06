# Speech

When the speech sidecar in `tools/tts/` is running, a line is synthesised before it is played and the mouth runs on the audio instead of on an estimate. When it is not, the line is mouthed silently on the timing the text implies, which is what a machine without the voice does and what the tests do.

Setting one up means putting WAV clips in `tools/tts/reference/clips/` and running one command:

```sh
make voice         # environment if needed, then encode the clips
make dev           # brings the voice up with everything else
make tts           # or run the voice on its own
```

The clips are the one part that cannot be automated: they are recordings of whoever the voice is supposed to be, and no other recordings substitute. A minute or two of clean single-speaker speech is enough, because the model conditions on a reference rather than training on a corpus. `make tts-vet` reports on a set without building anything, and `HASHIDATE_VOICE_DIR` moves the whole directory, including out of the repository.

After adding or removing reference clips, run `make tts-refs` to replace the encoded set, then restart the sidecar. A failed rebuild leaves the previous complete set available; removed clips stop contributing after a successful rebuild and restart.

The sidecar runs Irodori-TTS over the `Aratako/Semantic-DACVAE-Japanese-32dim` codec, installed from upstream at a pinned commit so that a voice comes out the same on a later run. `HASHIDATE_TTS_MODEL` picks the checkpoint: `small` (the default, `Aratako/Irodori-TTS-v4.1-Small`) `large` (`Aratako/Irodori-TTS-v4-Large`) or `mf` (`Aratako/Irodori-TTS-v4.1-Small-MF`, a MeanFlow distillation of small that samples at 4 steps rather than 16). Upstream measures large as closer to the reference speaker, and here it takes about twice as long per line, roughly the length of the line itself on an M5 Max; small is the default because a caller sending one turn at a time waits that long before every line, while a queued script mostly hides it by preparing the next line during the current one. Both share the codec, so the encoded reference set serves either without `make tts-refs`. Checkpoint and codec are fetched from Hugging Face the first time the sidecar starts, and `/health` reports which model is loaded and the step count it samples at. Nothing else is selectable, because the pinned upstream commit is known to run these three; a different model means a different sidecar — see [Using a different voice](#using-a-different-voice).

The sidecar answers on a UNIX socket at `tools/tts/.run/speech.sock`, in a directory it creates with mode `0700`, and opens no port at all. Its only caller is the control server on this machine — see [Using a different voice](#using-a-different-voice) — so the voice is reachable by this user and nobody else, which is a stricter form of the rule the rest of the runtime follows by binding loopback.

The control server prints what it found of the voice at startup and reports any change, and the panel carries the same warning. A sidecar that stops answering mid-broadcast is otherwise invisible, because the queue still drains and the mouth still moves.

The state is four values rather than a boolean:

| `speech` | What it means | What to do |
|---|---|---|
| `ready` | The model is loaded and answering | Nothing |
| `loading` | A sidecar is up and still bringing its model in, which takes the better part of a minute | Wait. Lines queued now go out silently |
| `absent` | No sidecar was ever found | Ordinary for a checkout that has not run `make voice`. Nothing is wrong |
| `down` | One answered earlier and has stopped | The state worth acting on. Check what it printed — under the native shell, `speech.log` |

The same value is on `GET /api/state` and in the native shell's Window menu. See [The native shell](shell.md#the-menu).

## Why synthesis completes before playback

Three things follow from having the finished take before playback starts, which is what the added second buys.

- **The viseme track is stretched onto the real length.** The estimate's constants only ever produce proportions, so normalising to a measurement cancels them, which is what makes the timing survive a voice retrained to speak at a different rate. On the development machine the estimate runs 15 % short on a long line and further short on a brief one, consistently.
- **The mouth is put on the audio's clock rather than the frame's.** Frames drop and audio does not, so a mouth adding up frame deltas can only run ahead. Cues read the same clock and are corrected by the same call.
- **Mouth travel is scaled by the take's own loudness.** It is measured off the decoded buffer once and normalised against that take's own level, so there is no gain to retune when the voice changes. That is what closes the mouth through a pause the text never predicted, and it hides most of what the stretch cannot fix.

Synthesis starts when a line is *queued* rather than when it is played, so a batch of three is three requests in flight at once and only the first turn of a run waits. See [Send a whole answer at once](control-api.md#send-a-whole-answer-at-once).

A voice that fails or hangs costs the line its sound and nothing else: the turn plays silently rather than holding up the queue.

## The watermark

Every take carries a SilentCipher watermark, sitting about 50 dB under the speech and identifying the audio as generated by this project. It is written last, after the noise removal, because a denoiser aimed at the level the mark lives at is a denoiser aimed at the mark. The sidecar checks a real take at startup and refuses to serve if the payload does not read back, so audio going out unmarked is a startup failure rather than something discovered later.

Below about a second of audio the payload stops being readable — a property of the scheme rather than of this pipeline — so a one-word turn goes out effectively unmarked. Padding it to reach the threshold is not available: the viewer measures the buffer it is handed to drive the mouth, so silence added to carry a watermark is silence the mouth would spend moving.

## The room

A take arrives with no space on it. The reference recordings carried one — a steady bed some 33 dB under the speech, which the model reproduced faithfully because reproducing the reference is its job — and it is removed from the references before they are ever encoded, so it never reaches a generated line. What the codec adds on top is removed from the take on the way out. Between them the speech-to-noise on a line goes from about 32 dB to about 50 dB.

That is the right raw material and the wrong thing to broadcast, because a voice with no early reflections reads as a voice in a vacuum. The room is therefore put back on the way to the speakers, and because it is a decision rather than an accident it is a command:

```sh
yarn ctl room hall
yarn ctl room            # dry
```

There are four — `booth`, `room`, `studio`, `hall` — each described as a physical space and turned into an impulse response, rather than dialled in as a decay time. The names come back in the vocabulary, and an unknown one is dry.

The order matters. The mouth is driven by an envelope measured off the *dry* take, before any of this, so the room can only ever be heard and never seen: it rings on after the mouth has closed, the way a room does, and an interrupt cuts the voice without cutting the space it was in. A long tail does overlap the next line — `hall` rings for well over a second, which is why it is not the default.

The acoustic is a separate axis from the set the character is *seen* in, so a backdrop can be cut without the microphone appearing to move. See [The stage](stage.md).

## Using a different voice

The renderer never talks to the synthesiser. It asks its own origin for audio and the control server proxies to the socket, so the synthesiser sits behind an interface rather than being wired in — the same arrangement that keeps the language model out of the runtime.

The contract is two routes:

| Route | What it takes, what it returns |
|---|---|
| `POST /speak` | A JSON body `{ "text": string }` → an `audio/*` response body. |
| `GET /health` | A JSON body with the required boolean field `ready`; other fields are optional. |

Anything that answers those can stand in. The `/speak` contract requires `text` only; `reading` is not part of it and is not sent. `HASHIDATE_TTS_SOCKET` moves the target, which is how to run a second sidecar beside the first while comparing voices, and `HASHIDATE_TTS_PORT` points the proxy at `127.0.0.1` on that port instead, which a stand-in written as an ordinary HTTP service will need. Nothing above the proxy depends on which of the two answered.

`HASHIDATE_TTS_SOCKET` is read by both the control server and `tools/tts/server.py`. The control server uses `HASHIDATE_TTS_PORT` only when no socket override is set. The bundled sidecar always uses a private UNIX socket and accepts no `--port` option. Start a TCP replacement service separately; the native shell does not start the bundled sidecar for a TCP endpoint.

What the renderer does with the answer is the same either way: it measures the buffer, stretches the viseme track onto the real length, and drives the mouth off the measurement. A synthesiser that returns a plain WAV gets all of that.

## Why it is a separate process

The engine holds no audio code. It states what a spoken line is, and the viewer, which has the `AudioContext`, provides one. The sidecar is a PyTorch codebase on its own Python 3.11 environment, reached over HTTP and never imported.

The viewer calls `POST /api/speech` on its own origin. The control server forwards the request over the private UNIX socket, which browsers cannot open directly. Neither the viewer nor the bundled sidecar sends a CORS header.

## Next

- [Lines and cues](lines-and-cues.md) — what the mouth is timing
- [The control API](control-api.md) — batching, and why it matters here
