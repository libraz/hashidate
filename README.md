# aituber

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-blue?logo=typescript)](https://www.typescriptlang.org/)

**aituber is an avatar runtime for an AI VTuber: a browser-rendered character
that an orchestrator drives over a local HTTP API, one turn of dialogue at a
time.** The renderer holds the character; the caller holds the script.

The engine holds no avatar data. Everything that is a property of one particular
model — what its author named things, how its garments are built, how far its
eyes turn, which of its shapes are drawn artwork rather than muscle-level parts —
lives in a descriptor, and the runtime reads it through a profile. Swapping the
avatar swaps that object and nothing else, which is the claim this repository
exists to test: two models by different authors, one of which implements the
ARKit 52 blendshape set and one of which implements none of it, driven by the
same engine over the same command vocabulary.

**Reach for it when you need to:**

- **Drive a character from an LLM loop** — one command is one turn: a line, a face and a movement, with an optional wait until the character has finished saying it.
- **Ask in the character's own terms** — 「うれしい」 rather than joy 0.9 with a cheer gesture and three hops of 45 mm. The named performances are the vocabulary, and the idle autopilot draws from the same table.
- **Change the avatar without touching the engine** — the descriptor is the only avatar-specific file, and what the model can be asked for is discovered from its own shapes and meshes rather than declared.
- **Keep the whole thing on one machine** — the viewer and the control API bind to loopback, and there is no cloud dependency anywhere in the runtime.

## What's inside

- **Profile discovery** — bones, finger families, visemes, blink shapes and drawn-expression groups resolved from whatever the model actually ships, with ARKit detected rather than assumed.
- **Performances** — a face and a movement named together, grouped by what kind of thing they are, entered and left as a state. One table, spoken by the control API, the console and the autopilot alike.
- **Motion** — gaze with saccades and a sprung head, breathing and weight-shift idles, a gesture table, hop runs, and an arm solved back from where the fingertip has to be, with the joint strain reported.
- **Face** — an emotion blend composed onto either ARKit or the model's own shapes, drawn expressions, layered effects, a blink scheduler with an eyelid droop, and text-timed lipsync.
- **Secondary motion** — spring chains for hair and garments, with colliders and a tail.
- **Wardrobe** — slots, presets and the hide-shapes that go with them, read from the model's meshes.
- **The control API** — commands down an SSE stream, state and turn events back, and a vocabulary object built for pasting into a system prompt.

## Repository layout

| | |
|---|---|
| `src/engine` | The runtime. Profile, rig, anatomy, motion, face, secondary motion, director, session. Depends on three.js and on nothing in a browser. |
| `src/avatars` | One descriptor per model. Adding an avatar is adding a file. |
| `src/protocol` | The wire format, as zod schemas. The viewer, the server and the CLI all import it, so the command vocabulary cannot drift between them. |
| `src/viewer` | The operator console: a React panel beside a three.js stage. |
| `src/server` | The local control API. Serves the built viewer and carries commands to it. |
| `src/cli` | `ctl` — a thin client, for driving the avatar by hand. |
| `tools/blender` | The model pipeline. Python, because it runs inside Blender. |

## Requirements

- Node and Yarn, pinned in `mise.toml` — `mise install`
- Blender, for the model pipeline only
- The avatar packages themselves, which are commercial products and are **not**
  in this repository. See [Assets](#assets).

## Quick start

```sh
yarn install
yarn dev
```

`yarn dev` starts the viewer on `127.0.0.1:5173` and the control API on
`127.0.0.1:8765`, and proxies `/api` from the first to the second. Drive it from
another terminal:

```sh
yarn ctl vocab                                  # what this avatar can be asked to do
yarn ctl perform happy                          # a face and a movement, named together
yarn ctl say "こんばんは" --perform hello --wait
yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"
yarn ctl perform                                # put it back
yarn ctl point 40 25 --extent 0.9 --finger little
yarn ctl idle on
yarn ctl watch                                  # follow the turn events
```

`yarn build` produces a static viewer in `dist/`; `yarn start` serves it from the
control server alone, without vite.

For a character that is actually audible, `make tts-setup` once and then
`make tts` alongside. It is optional in the real sense — see [Speech](#speech).

## The control API

An orchestrator — in production, an LLM loop — posts commands and reads state:

```
orchestrator  ──POST /api/command──►  server  ──SSE──►  viewer
              ◄──GET  /api/state───          ◄─POST──
```

The unit of work is a **turn**: one line of dialogue delivered with a face and a
gesture, followed by the next one. `POST /api/command?wait=1` blocks until the
turn ends, so a caller with nothing to do until the character stops talking does
not have to poll.

### Performances

What a turn is *delivered with* is usually a **performance** — a named face and
movement together, like 「うれしい」 or 「ねおち」. The layers underneath are
separate for good reasons (an emotion is a continuous blend that persists, a
gesture is discrete and ends, a hop moves the whole skeleton) and none of them is
the shape a caller thinks in.

The table is grouped, and the group says what kind of thing an entry is: 気分
(mood — a face and nothing else, which is most of what watching a character
actually looks like), 相槌, 挨拶, 説明, 感情, 仕草, and ポーズ, which is held
until something else is asked for. Every gesture the engine has appears in at
least one performance, and a test says so: a movement with no face attached is
one the autopilot would eventually play deadpan.

A performance is a **state**, not an event. Starting one ends the last — the pose
comes down, a raised effect is lowered, a droop on the eyelids is released. Its
mood is the exception and persists, for the same reason a turn's emotion does:
a mood does not end with the sentence that carried it.

The parts stay reachable for what the table has no name for. The idle autopilot
draws from the same table, so what the character does on its own and what it can
be asked to do are one vocabulary.

### Cues in a line

A performance usually applies to a whole turn. When it has to change *inside*
one, it is written into the line:

```
[hello]こんばんは。[explain]今日はこの話をします。
```

A bracketed performance id starts that performance where it is written, and
there is no other way to place one mid-sentence: a second turn would put a gap
and a breath in the middle of a clause, and a separate `perform` command cannot
know when the first half has been said — only the renderer knows how long that
takes.

**Brackets are reserved, and nothing inside them is ever spoken.** That is the
reason the syntax exists in this shape rather than a detail of it. The caller is
a language model, everything it writes goes to the mouth, and a character
reading a stage direction out loud is the failure the design is arranged around.
So it is guaranteed twice: a line whose markup does not parse fails the schema
and the command is dropped, which keeps the character quiet and tells the
caller — and the parser behind that is total, so a line arriving by any other
route comes out with its markup removed rather than read. There is no flag that
turns parsing off, and no second field a line can arrive on.

A cue's position is a fraction of the utterance rather than a time, and it rides
the mouth's own clock, so it stays where it was written when the line turns out
longer than the estimate: a supplied `reading` is a different length, and TTS
audio is a different length again. An id the performance table does not have is
dropped — mid-sentence, a typo should do nothing rather than take the
character's face away.

### Speech

If the speech sidecar in `tools/tts/` is running, a line is synthesised before
it is played and the mouth runs on the audio instead of on an estimate. If it is
not, nothing changes: the line is mouthed silently on the timing the text
implies, which is what a machine without the voice does and what the tests do.

Three things follow from having the finished audio in hand *before* the turn
opens, which is worth the second it costs:

- **The viseme track is stretched onto the real length.** The estimate's
  constants only ever produce proportions, so normalising to a measurement
  cancels them — which is what makes the timing survive a voice retrained to
  speak at a different rate. On this machine the estimate runs 15% short on a
  long line and far shorter on a brief one, every time.
- **The mouth is put on the audio's clock rather than the frame's.** Frames drop
  and audio does not, and a mouth adding up frame deltas can only ever run
  ahead. Cues read the same clock, so they are corrected by the same call.
- **Mouth travel is scaled by the take's own loudness.** Measured off the
  decoded buffer once, normalised against that take's own level so there is no
  gain to retune with the voice. It is what closes the mouth through a pause the
  text never predicted, and it hides most of what the stretch cannot fix.

Synthesis starts when a line is *queued* rather than when it is played, so a
batch of three is three requests in flight at once and only the first turn of a
run waits. A voice that fails or hangs costs the line its sound and nothing
else: the turn plays silently rather than holding up the queue.

### Commands

| | |
|---|---|
| `perform` | A named face and movement. No id releases the one that is up. |
| `say` | Queue a turn. Takes a `perform`, or the parts spelled out, or performances written into the text itself. `hold` keeps the face up past the line. `reading` gives the kana pronunciation where the writing does not determine it, and carries no cues of its own. |
| `emotion` | The persistent mood, as a blend rather than a choice. |
| `expression` | One of the avatar's own drawn faces. `null` hands the face back to the emotion. |
| `overlay` | A drawn effect, at a weight. It layers over whatever face is showing, so several can be up at once. |
| `gesture` | One movement from the gesture table. No id stops it. |
| `hop` | A run of hops. Its own command rather than a gesture because it translates the whole skeleton, and runs alongside whatever the arms are doing. |
| `point` | Aim a fingertip at a bearing — degrees on the wire, and any of the five fingers. Held until released. |
| `look` | How much the gaze tracks the camera, 0 to 1. |
| `idle` | The autopilot, on or off. |
| `camera` | The framing: `face`, `bust`, `upper`, `full`. |
| `wear` | One slot to an item, or a whole preset at once. |
| `interrupt` / `clear` / `reset` | Stop mid-line and drop the queue / drop the queue and let the line finish / back to nothing. |

A command the renderer does not understand is dropped rather than failing the
request, and unknown fields are stripped: the orchestrator and the renderer are
separate processes with separate release cycles, and a newer caller talking to an
older renderer should degrade rather than break the stream.

### Endpoints

| | |
|---|---|
| `POST /api/command` | One command, or several under `batch` to be delivered together. `?wait=1` returns when the last queued turn ends. |
| `GET /api/state` | Connection, the current state, and the event tail since `?since=`. |
| `GET /api/events` | The event tail alone. `?wait=1` long-polls it. |
| `GET /api/vocabulary` | What the loaded avatar can be asked for. |
| `GET /api/stream` | The viewer's SSE down-channel. |
| `POST /api/report` | The viewer's up-channel, and its heartbeat. Not for callers. |
| `POST /api/speech` | The viewer's route to the speech sidecar. Not for callers. 503 when there is no sidecar, which is a normal answer. |

`/api/speech` is a proxy rather than the viewer calling `tools/tts/` directly,
and for the same reason everything else here is loopback: the sidecar sends no
CORS header, so a page served from this origin cannot reach that one. The two
ways to make a direct call work would be to add a CORS header to the voice or to
move it off loopback, and both are licensing decisions. Proxying is neither.

### What comes back

`GET /api/vocabulary` returns what the loaded avatar can be asked for. It is
discovered rather than declared — the expression list comes from the model's own
shape groups and the wardrobe from its meshes — so it changes when the avatar
does. That object is the one to paste into a system prompt, and the cue syntax
is stated in it for that reason: a syntax the caller is never told about is a
syntax nobody uses.

`GET /api/state` is everything worth branching on, cheap enough to poll:
`speaking`, the turn id, the queue depth, the emotion vector, the drawn
expression and the raised effects, the performance and gesture that are up, and
`strain` — what the last fingertip solve cost each arm. Pointing is deliberately
*not* bounded to the range the vocabulary advertises. Those bounds are
anatomical, and reaching past them is a supported outcome rather than an error:
the arm goes as far as it can, which is what a person does, and the strain figure
is the only way a caller can tell an aim that was met from one the arm could only
approximate.

## The console

The panel beside the stage is four tabs — 演じる (performances, emotions, drawn
faces, effects, gestures, pointing), 装う (the wardrobe), 調律 (idle, secondary
motion, hops, rendering) and 診る (read-only: joint strain, the resolved profile,
the event log, the vocabulary). The avatar picker, the camera framing, the idle
switch and the speech box sit outside the tabs, because none of them belongs to
one of those four jobs.

It drives the same `Session` the control API does, rather than being a second
path into the engine — which is what makes it usable as a check on the API.

## Assets

The two validation avatars are purchased VRChat models. Their source packages,
the extracted meshes and textures, and the GLB the viewer loads are all
git-ignored: they are 1.5 GB together, and they are not ours to redistribute.

The pipeline turns a purchased package into a GLB:

```sh
make            # what each target does
make extract    # purchased zip  → backup/resource/
make textures   # unitypackage   → PNG
make resize     # 4K            → web-sized
make glb        # FBX           → public/models/*.glb
```

`make check-assets` fails if anything over 1 MB has found its way into git. It
runs against what git is actually tracking rather than against a list of paths,
because a `.gitignore` only covers the paths someone thought of and a single
half-gigabyte blob in the history is permanent.

## Development

```sh
yarn typecheck
yarn lint          # biome
yarn test          # vitest
```

Tests build a synthetic avatar in code rather than loading a GLB — a suite that
needs a purchased 16 MB model can only run on a machine that has bought it. See
`tests/helpers/scene.ts`.

The numbers in `src/engine` were arrived at by watching two real avatars, and
most of them carry a comment naming the failure they exist to prevent. They are
not defaults to be tidied: changing one is a decision that needs a look at the
render.

## Non-goals

aituber renders and animates a character; it is not the VTuber. It does not
include a language model, speech recognition, or a stream output, and the
orchestrator that decides what to say lives outside this repository.

Speech is the one thing that crossed the line, and only as far as `tools/tts/`:
a sidecar that turns a line into audio, reached over HTTP and never imported.
The engine holds no audio code either — it states what a spoken line is and the
viewer, which has the `AudioContext`, provides one. Without a sidecar the whole
thing runs as before, with the mouth timed from the text.

It is also deliberately loopback-only. There is no `--host` flag, no CORS header
and no tunnel, because the avatars used for validation may not be republished:
exposing the renderer would be a licensing decision before it was a code change.

The engine is a runtime, not an editor. Rigging, weighting and garment authoring
happen in Blender, and `tools/blender` is the seam between the two.

## License

[Apache-2.0](LICENSE) — the code in this repository.

Nothing under `backup/` or `public/models/` is covered by it. The avatars are
purchased commercial models under their authors' own terms, and this licence
cannot and does not extend to them: a checkout gives you the runtime, not the
characters it was built against.
