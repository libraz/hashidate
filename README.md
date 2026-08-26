# aituber

An avatar runtime for an AI VTuber: a browser-rendered character that an
orchestrator drives over a local HTTP API, one turn of dialogue at a time.

The engine holds no avatar data. Everything that is a property of one particular
model — what its author named things, how its garments are built, how far its
eyes turn, which of its shapes are drawn artwork rather than muscle-level parts —
lives in a descriptor, and the runtime reads it through a profile. Swapping the
avatar swaps that object and nothing else, which is the claim this repository
exists to test: two models by different authors, one of which implements the
ARKit 52 blendshape set and one of which implements none of it, driven by the
same engine over the same command vocabulary.

## What is here

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
  in this repository. See *Assets* below.

## Running

```sh
yarn install
yarn dev
```

`yarn dev` starts the viewer on `127.0.0.1:5173` and the control API on
`127.0.0.1:8765`, and proxies `/api` from the first to the second. Both bind to
loopback and are meant to: the avatars used for validation may not be
republished, so the renderer must not be reachable from another machine.

Drive it from another terminal:

```sh
yarn ctl vocab                     # what this avatar can be asked to do
yarn ctl say "こんばんは" --emotion joy=0.8 --gesture wave --wait
yarn ctl expression F_NIKONIKO
yarn ctl point 40 25 --extent 0.9
yarn ctl idle on
yarn ctl watch                     # follow the turn events
```

`yarn build` produces a static viewer in `dist/`; `yarn start` serves it from the
control server alone, without vite.

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

`GET /api/vocabulary` returns what the loaded avatar can be asked for. It is
discovered rather than declared — the expression list comes from the model's own
shape groups and the wardrobe from its meshes — so it changes when the avatar
does. That object is the one to paste into a system prompt.

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

## Licence

Not decided. This is a validation repository and its distribution shape is still
open; there is deliberately no `LICENSE` file rather than a placeholder one.
