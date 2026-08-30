# hashidate

An avatar runtime for an AI VTuber: a browser-rendered character that something else drives over a local HTTP API, one turn of dialogue at a time. The renderer holds the character; the caller holds the script.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![three.js](https://img.shields.io/badge/three.js-r185-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![MCP](https://img.shields.io/badge/MCP-8%20tools-1a6873)](docs/en/mcp.md)
[![docs](https://img.shields.io/badge/docs-guides-b5892e)](docs/en/introduction.md)

![The broadcast panel running a loaded script](docs/images/panel.webp)

A script loaded on the queue: one line on air, nineteen waiting, each with a performance on it. The panel is driving the same control API an orchestrator would.

## It depends on no model

hashidate is an adapter, not an application. There is no provider SDK in the dependency tree, no API key to configure, and no persona, prompt, script or conversation state — those stay on your side of the line. What crosses the line is one turn — some words, optionally a performance to say them with, optionally the shot to say them in — and a character says and performs it.

![What crosses the boundary](docs/images/boundary.svg)

Swap the model, the provider or the framework: nothing on the right-hand side changes. The same runtime is driven from an LLM loop in any language, from an MCP client, from a shell script with no model in it at all, or by a person at the broadcast panel — and all four can be mixed in one broadcast.

## What you can build with it

| Use case | What it does | The part you touch |
|---|---|---|
| **An AI VTuber answering chat** | Your loop decides the line; hashidate says it and performs it. | `POST /api/command`, or the `speak` MCP tool |
| **Commentary over a game** | She stands on the game capture with nothing behind her; OBS composites. | `?transparent=1&place=bottom-right:0.32x0.6` |
| **A talk given from slides** | A PDF behind her, page turns riding on the lines. The deck is readable as text, so a model can write the script for it. | `deck`, `say --slide 2` |
| **A scripted segment** | No model anywhere. A shell script is a perfectly good orchestrator. | `yarn ctl say …` |
| **A segment recorded to a file** | Load a script, frame the shot against a queue that is already synthesising, press record. The mp4 lands in `show/recordings/`. | The panel's Queue and Recording tabs |
| **A broadcast with background music** | MP3 or FLAC from a local show directory, with its own level and libsonare effects. | The panel's BGM tab, or the `bgm` MCP tool |
| **A broadcast run by hand** | The panel is a full operating surface, and everything it does goes through the same API. | `/panel/` |
| **Checking a model you rigged** | What the avatar can be asked for is discovered from its own shapes and meshes. | `yarn ctl vocab` |

![A page of the demo deck, with the character standing in the corner of the same frame](docs/images/slides.webp)

The third of those, on air. The deck is a PDF the server reads off disk, the character is placed in a corner of the same frame, and the page turns arrive on the lines — one browser source, and OBS composites nothing.

Worked versions of all eight: [Use cases](docs/en/use-cases.md).

## What you need

A clone of this repository is the runtime and nothing else. Two of the things it needs are deliberately not in the box:

| Requirement | Notes |
|---|---|
| Node 22 and Yarn 4 | Pinned in `mise.toml`. `mise install` gets both. |
| **An avatar** | Required, and **not included.** The descriptors in `src/avatars` point at `public/models/<id>.glb`, which is git-ignored, so a fresh clone has nothing to draw. The two models this was built against are purchased and not ours to redistribute — bring your own, put it through `make glb`, and add one descriptor file. |
| **A voice** | Not required to run, required in practice: a VTuber that never makes a sound is a test fixture. Needs `uv` and Python 3.11, and several GB of PyTorch come with it. The recordings it clones a voice from are of a real person and are **not included** either — bring your own. |
| Blender, OBS | Only to convert a model, and only to put the result on a stream. |

Setting the voice up is putting a minute or two of WAV clips in `tools/tts/reference/clips/`, which ships empty for the purpose, and running `make voice` once. Without one everything still runs: the line is mouthed silently on the timing the text implies, which is what the tests do. It is worth knowing that this works, and it is not what you want on a stream.

The voice is swappable for the same reason the model is — anything that answers `POST /speak` → WAV can stand in for the sidecar. See [Speech](docs/en/speech.md).

The details, and what a first run looks like: [Getting started](docs/en/getting-started.md).

## Quick start

```sh
mise install
yarn install
make dev
```

The viewer comes up on `127.0.0.1:5173`, the control API on `127.0.0.1:8765` and the speech sidecar — if its environment has been built — on a socket at `tools/tts/.run/speech.sock`. `yarn dev` starts the first two alone, and `yarn shell` opens the panel and the stage as native windows with all three underneath.

Drive it from another terminal:

```sh
yarn ctl vocab                                  # what this avatar can be asked to do
yarn ctl perform happy                          # a face and a movement, named together
yarn ctl say "Good evening." --perform hello --wait
yarn ctl say "[hello]Good evening. [explain]Tonight I want to talk about this."
yarn ctl bgm list && yarn ctl bgm play opening.mp3
yarn ctl idle on                                # let her perform by herself; breath and gaze were already running
yarn ctl watch                                  # follow the turn events
```

## How it fits together

![hashidate architecture](docs/images/architecture.svg)

Three processes and a page. A caller posts commands to the control server; the server streams them to the renderer over SSE and the renderer reports back. OBS points at the renderer's page. Everything binds to `127.0.0.1`. See [Architecture](docs/en/architecture.md).

## Documentation

Start here: [Introduction](docs/en/introduction.md), [Use cases](docs/en/use-cases.md), [Getting started](docs/en/getting-started.md).

Driving it: [The control API](docs/en/control-api.md), [Commands](docs/en/commands.md), [Performances](docs/en/performances.md), [Lines and cues](docs/en/lines-and-cues.md), [Scripts](docs/en/scripts.md), [The MCP adapter](docs/en/mcp.md).

The picture and the sound: [Speech](docs/en/speech.md), [Background music](docs/en/bgm.md), [The stage](docs/en/stage.md), [Slides](docs/en/slides.md), [Motions](docs/en/motions.md), [Recording](docs/en/recording.md), [The surfaces](docs/en/surfaces.md).

Under it: [Architecture](docs/en/architecture.md), [Avatars](docs/en/avatars.md).

## Non-goals

hashidate renders and animates a character; it is not the VTuber. It has no language model, no speech recognition and no stream output, and the orchestrator that decides what to say lives outside this repository. Speech is the one thing that crossed the line, and only as far as `tools/tts/`: a sidecar reached over HTTP and never imported.

It is also deliberately loopback-only. There is no `--host` flag, no CORS header and no tunnel, because the avatars used for validation may not be republished: exposing the renderer would be a licensing decision before it was a code change.

The model data does not leave that loop. The browser reads it from `127.0.0.1` and draws it; nothing in the runtime copies it, uploads it or learns from it.

The engine is a runtime, not an editor: rigging, weighting and garment authoring happen in Blender, and `tools/blender` is the seam between the two.

## Development

```sh
yarn typecheck
yarn lint          # biome
yarn test          # vitest
```

Tests build a synthetic avatar in code rather than loading a GLB — a suite that needs a purchased 16 MB model can only run on a machine that has bought it.

The numbers in `src/engine` were arrived at by watching two real avatars, and most of them carry a comment naming the failure they exist to prevent. They are not defaults to be tidied: changing one is a decision that needs a look at the render.

## License

[Apache-2.0](LICENSE) — the code in this repository.

Nothing under `public/models/` is covered by it. The avatars are purchased commercial models under their authors' own terms: a checkout gives you the runtime, not the characters it was built against.

The wall and floor textures in `public/textures/` are CC0 1.0, from ambientCG (`WoodFloor001`, `Fabric019`).
