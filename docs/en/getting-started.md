# Getting started

## What you need

A clone of this repository is the runtime and nothing else. Read this section before the first `yarn install`, because two of the things it needs are deliberately not in the box.

### To run it at all

| Requirement | Notes |
|---|---|
| Node 22 and Yarn 4 | Pinned in `mise.toml`. `mise install` gets both. |
| **An avatar** | Required, and **not included.** The descriptors in `src/avatars` point at `public/models/<id>.glb`, which is git-ignored. With no GLB there the renderer comes up with nothing to draw. |

The two avatars this project was built against are purchased VRChat models and are not ours to redistribute. So you supply your own: put a rigged humanoid model through `make glb` and add one descriptor file to `src/avatars`. That is the whole of adding an avatar — see [Avatars](avatars.md).

### To hear it

| Requirement | Notes |
|---|---|
| `uv`, and Python 3.11 | The sidecar's environment is built from them. It pulls in PyTorch, which is several GB on its own. |
| **Reference audio** | Required for the voice, and **not included.** The sidecar clones a voice from recordings, and the ones this project uses are of a real person and are not ours to publish in any form. |

Put a few WAV files in `tools/tts/reference/clips/` — the directory ships empty for exactly this — and run one command:

```sh
make voice
```

That builds the Python environment if there is not one, inspects the clips, and encodes them into the latents the sidecar loads at startup. Re-running after adding a clip only redoes the encoding.

Clean speech, one speaker, no music and no second voice. A minute or two in total is enough: this is a reference, not a training set. `make tts-vet` reports on a set without building anything, and `make voice` refuses to build from a clip that failed it — a reference the voice should not have is not something a later setting can undo. `HASHIDATE_VOICE_DIR` points all of it somewhere else, including outside the repository.

Strictly speaking the sidecar is optional: without it a line is mouthed silently on the timing the text implies, which is what the tests do and what a machine without the voice does. In practice a VTuber that never makes a sound is a test fixture, so budget for this rather than treating it as an extra.

If a different synthesiser suits you better, the renderer never talks to this one directly — anything answering `POST /speak` with `{ text, reading? }` → WAV and `GET /health` on that port can stand in. See [Speech](speech.md#using-a-different-voice).

### Only if you need them

| Tool | When it is needed |
|---|---|
| Blender | Only to convert a purchased or authored model into a GLB. Not needed to run anything. |
| OBS | Only to put the result on a stream. The renderer is an ordinary page. |

## Run it

```sh
yarn install
make dev
```

`make dev` starts the viewer on `127.0.0.1:5173`, the control API on `127.0.0.1:8765` and the speech sidecar on `127.0.0.1:8770`, and proxies `/api` from the first to the second. The sidecar is left out when its environment is not built, which is the usual case; `yarn dev` starts the first two alone.

Drive it from another terminal:

```sh
yarn ctl vocab                                  # what this avatar can be asked to do
yarn ctl perform happy                          # a face and a movement, named together
yarn ctl say "Good evening." --perform hello --wait
yarn ctl say "[hello]Good evening. [explain]Tonight I want to talk about this."
yarn ctl perform                                # put it back
yarn ctl point 40 25 --extent 0.9 --finger little
yarn ctl idle on
yarn ctl watch                                  # follow the turn events
```

`yarn build` produces a static viewer in `dist/`; `yarn start` serves it from the control server alone, without vite.

## Give her a voice

For a character that is actually audible, put clips in `tools/tts/reference/clips/` and run `make voice` once — see [What you need](#to-hear-it). After that `make dev` brings the voice up with everything else, and `make tts` runs it on its own. It is optional in the real sense: without it a line is mouthed silently on the timing the text implies, which is what the tests do. See [Speech](speech.md).

The control server prints what it found of the voice at startup and says so again if that changes, and the panel carries the same warning. A sidecar that stops answering mid-broadcast is otherwise invisible, because the queue still drains and the mouth still moves.

## Point OBS at it

The renderer is on `/`, and it opens as the character and nothing else — no console, no HUD, no cursor. That URL is what a browser source is given:

```
http://127.0.0.1:8765/?size=1920x1080&backdrop=night
```

Add `?transparent=1` to drop the background and let OBS composite the character over a game capture instead. See [The stage](stage.md).

## Run the checks

```sh
yarn typecheck
yarn lint          # biome
yarn test          # vitest
```

Tests build a synthetic avatar in code rather than loading a GLB — a suite that needs a purchased 16 MB model can only run on a machine that has bought it. See `tests/helpers/scene.ts`.

The numbers in `src/engine` were arrived at by watching two real avatars, and most of them carry a comment naming the failure they exist to prevent. They are not defaults to be tidied: changing one is a decision that needs a look at the render.

## Next

- [Use cases](use-cases.md) — what to build with it
- [The control API](control-api.md) — the thing an orchestrator talks to
- [Commands](commands.md) — the full vocabulary
