# Introduction

hashidate is an avatar runtime for an AI VTuber: a browser-rendered character driven over a local HTTP API, one turn of dialogue at a time. The renderer holds the character; the caller holds the script.

It is an adapter, not an application. It knows nothing about language models and depends on none: there is no provider SDK in the dependency tree, no API key to configure, and no persona, prompt, script or conversation state — all of that stays on the caller's side. What arrives is a turn: some words, optionally a performance to deliver them with, optionally the shot to deliver them in. The character then says and performs it.

![What crosses the boundary](../images/boundary.svg)

## Why the boundary sits there

Everything on the caller's side changes quickly and belongs to whoever is building the character: which model, what persona and prompt, what is remembered, what the script says and in what order, and whether the words come from a chat window, from speech recognition, or from a file. Everything on the runtime's side is a rendering problem that does not change when any of that changes: where the eyes go, how long the mouth stays open, when the hair catches up with the head.

Keeping the two apart means a model swap is not a code change in the runtime, and a renderer change is not a rewrite of the orchestrator. hashidate is usable from:

- an LLM loop in any language, talking to `POST /api/command`
- an MCP client, with the same API exposed as eight tools
- a shell script with no model in it at all
- the broadcast panel, driven by an operator

All four go down the same path and can be mixed in one broadcast.

## What crosses the boundary

One turn, which is a small object:

| Field | What it is |
|---|---|
| `text` | What to say. Performance cues may be written into it in brackets. |
| `perform` | A named face and movement, or the parts spelled out. Optional. |
| `stage` | The camera, the set, the acoustic and the document for this line. Optional. |
| `reading` | Kana pronunciation, where the writing does not determine it. Optional. |

Nothing in it names a model, a voice or an avatar. The same turn plays on a different character, in a different room, with a different voice, without being rewritten.

## What the runtime provides

- **Profile discovery** — bones, finger families, visemes, blink shapes and drawn-expression groups resolved from whatever the model actually ships. ARKit support is detected rather than assumed.
- **Performances** — a face and a movement named together, grouped by kind, entered and left as a state. One table, shared by the control API, the panel and the idle autopilot.
- **Motion** — gaze with saccades and a sprung head, breathing and weight-shift idles, a gesture table, hop runs, and an arm solved back from where the fingertip has to be, with the joint strain reported. Keyframe motions load off disk beside the built-in table without joining it.
- **Face** — an emotion blend composed onto either ARKit or the model's own shapes, drawn expressions, layered effects, a blink scheduler with an eyelid droop, and text-timed lipsync.
- **Secondary motion** — spring chains for hair and garments, with colliders and a tail.
- **Wardrobe** — slots, presets and the hide-shapes that go with them, read from the model's meshes.
- **Sets and acoustics** — four generated rooms to be seen in and four to be heard in, on separate axes.
- **Slides** — a PDF behind the character, at the frame's own resolution, readable as text by whatever is writing the script.
- **Sound around the voice** — background music from the show directory, on its own level and its own effects, under one audio graph the page owns.
- **Recording** — a take written to a file by the renderer that is on air, with no compositor in between.

## Avatar data lives in a descriptor

Everything that is a property of one particular model — what its author named things, how its garments are built, how far its eyes turn, which of its shapes are drawn artwork rather than muscle-level parts — lives in a descriptor, and the runtime reads it through a profile. Swapping the avatar swaps that object and nothing else.

That claim is what this repository tests: two models by different authors, one implementing the ARKit 52 blendshape set and one implementing none of it, driven by the same engine over the same command vocabulary. See [Avatars](avatars.md).

## Non-goals

hashidate renders and animates a character; it is not the VTuber. It has no language model, no speech recognition and no stream output, and the orchestrator that decides what to say lives outside this repository.

Speech synthesis is the one exception, and it is confined to `tools/tts/`: a sidecar that turns a line into audio, reached over HTTP and never imported. Without it the runtime still works, with the mouth timed from the text. See [Speech](speech.md).

The runtime is loopback-only. There is no `--host` flag, no CORS header and no tunnel, because the avatars used for validation may not be republished; exposing the renderer would be a licensing decision before a code change.

The engine is a runtime, not an editor. Rigging, weighting and garment authoring happen in Blender, and `tools/blender` is the interface between the two.

## The guides

Read the first three in order. The rest are reference pages, each reachable from wherever it is needed.

**Start here**

| Guide | What it answers |
|---|---|
| [Use cases](use-cases.md) | What the runtime is used for — eight worked shapes |
| [Getting started](getting-started.md) | Requirements, a first run, and what is configurable |
| [Architecture](architecture.md) | Which process holds what, and which boundaries are load-bearing |

**Driving it** — the four callers all go down this path

| Guide | What it answers |
|---|---|
| [The control API](control-api.md) | The endpoints, batching a whole answer, what comes back in state |
| [Commands](commands.md) | The full vocabulary, in one table |
| [Performances](performances.md) | `perform` — a face and a movement, named together |
| [Lines and cues](lines-and-cues.md) | `say` — the bracket syntax written into a line |
| [Scripts](scripts.md) | A run of turns, written down in a file |
| [The MCP adapter](mcp.md) | The same API as eight tools a model can be handed |

**The picture and the sound**

| Guide | What it answers |
|---|---|
| [Speech](speech.md) | The sidecar, the watermark, the room, swapping the voice |
| [Background music](bgm.md) | The library, its transport, its own level and effects |
| [The stage](stage.md) | The set, transparency over a game, where the character stands in the frame |
| [Slides](slides.md) | A PDF behind the character, and reading one as text |
| [Motions](motions.md) | A keyframed gesture of your own, loaded off disk |
| [Recording](recording.md) | Writing a take to a file, and what comes out |
| [The surfaces](surfaces.md) | The three pages, the renderer's URL, the standing state |
| [The native shell](shell.md) | Running the whole thing as one application |

**Under it**

| Guide | What it answers |
|---|---|
| [Avatars](avatars.md) | The descriptor, the wardrobe, and why the runtime is loopback-only |
