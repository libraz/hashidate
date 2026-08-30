# Getting started

## Requirements

A clone of this repository is the runtime and nothing else. Read this section before the first `yarn install`, because two of the requirements are deliberately not included.

### To run the runtime

| Requirement | Notes |
|---|---|
| Node 22 and Yarn 4 | Pinned in `mise.toml`. `mise install` installs both. |
| **An avatar** | Required, and **not included.** The descriptors in `src/avatars` point at `public/models/<id>.glb`, which is git-ignored. With no GLB there, the renderer comes up with nothing to draw. |

The two avatars this project was built against are purchased VRChat models and cannot be redistributed here, so supply your own: put a rigged humanoid model through `make glb` and add one descriptor file to `src/avatars`. That is the whole of adding an avatar — see [Avatars](avatars.md).

### To produce audio

| Requirement | Notes |
|---|---|
| `uv`, and Python 3.11 | The sidecar's environment is built from them. It pulls in PyTorch, which is several GB on its own. |
| **Reference audio** | Required for the voice, and **not included.** The sidecar clones a voice from recordings, and the ones this project uses are of a real person and cannot be published in any form. |

Put a few WAV files in `tools/tts/reference/clips/` — the directory ships empty for this purpose — and run one command:

```sh
make voice
```

That builds the Python environment if there is not one, inspects the clips, and encodes them into the latents the sidecar loads at startup. Re-running after adding a clip only redoes the encoding.

Use clean speech, one speaker, no music and no second voice. A minute or two in total is enough, because this is a reference rather than a training set. `make tts-vet` reports on a set without building anything, and `make voice` refuses to build from a clip that failed it — a reference that reaches the encoded latents cannot be undone by a later setting. `HASHIDATE_VOICE_DIR` moves all of it elsewhere, including outside the repository.

The sidecar is optional: without it a line is mouthed silently on the timing the text implies, which is what the tests do and what a machine without the voice does. That path is for tests and development rather than for broadcast.

The renderer never talks to this synthesiser directly, so a different one can stand in. Anything accepting `{ "text": string }` at `POST /speak`, returning `audio/*`, and answering `GET /health` with a JSON boolean `ready` will work. See [Speech](speech.md#using-a-different-voice).

### Optional tools

| Tool | When it is needed |
|---|---|
| Blender | Only to convert a purchased or authored model into a GLB. Not needed to run anything. |
| OBS | Only to put the result on a stream. The renderer is an ordinary page. |

## Run it

```sh
yarn install
make dev
```

`make dev` starts the viewer on `127.0.0.1:5173`, the control API on `127.0.0.1:8765` and the speech sidecar on a UNIX socket, and proxies `/api` from the first to the second. The sidecar is left out when its environment is not built, which is the usual case; `yarn dev` starts the first two alone.

Ctrl-C stops all three. When they exit without that chance — a closed terminal, a dropped connection — the old processes keep the two ports and the socket, and the next `make dev` fails to bind. `make stop` frees them. It goes by address rather than by anything it remembers, so it clears a listener left by any project, and prints each one before ending it. A socket file left behind by a sidecar that was killed rather than stopped is removed too, because a bind onto one of those fails exactly as a real collision does.

Drive it from another terminal:

```sh
yarn ctl vocab                                  # what this avatar can be asked to do
yarn ctl perform happy                          # a face and a movement, named together
yarn ctl say "Good evening." --perform hello --wait
yarn ctl say "[hello]Good evening. [explain]Tonight I want to talk about this."
yarn ctl bgm list                              # MP3 and FLAC in show/bgm/
yarn ctl bgm play opening.mp3 --volume 0.2
yarn ctl perform                                # release the performance
yarn ctl point 40 25 --extent 0.9 --finger little
yarn ctl idle on
yarn ctl watch                                  # follow the turn events
```

A whole segment can also be sent at once. `show/scripts/demo.yaml` is the runtime introducing itself, in about two minutes, and it is the quickest way to see what a turn looks like:

```sh
yarn ctl play demo --check      # read it, no server needed
yarn ctl play demo --replace    # run it
```

See [Scripts](scripts.md).

Background music is optional and needs no import step. Put `.mp3` or `.flac` files directly in `show/bgm/`; the directory is re-read when it is listed from the panel, CLI or MCP. Its contents are git-ignored. See [Background music](bgm.md).

`yarn build` produces a static viewer in `dist/`; `yarn start` serves it from the control server alone, without vite.

`yarn shell` does both and opens the panel and the stage as native windows, with the control server and the speech sidecar started underneath and stopped again on quit. It runs the same three pages on the same loopback addresses. What it adds is windows that come back where they were left, a stage allowed to start its audio without being clicked first, and one menu item deciding whether this machine hears the character. See [The native shell](shell.md).

## Configuration

There is very little of it. **Nothing here sets an address.** There is no `--host`, no CORS header and no tunnel, because the avatars used for validation may not be republished — see [Avatars](avatars.md#licensing-is-why-the-runtime-is-loopback-only).

The control server takes seven flags, all of them paths except the first:

| Flag | Default | What it moves |
|---|---|---|
| `--port` | `8765` | The control API's port. The bind address is always `127.0.0.1` |
| `--root` | `dist` | The built viewer it serves the three pages from |
| `--slides` | `show/slides` | The documents. See [Slides](slides.md) |
| `--scripts` | `show/scripts` | The scripts the panel and `ctl play` both read. See [Scripts](scripts.md) |
| `--motions` | `show/motions` | Gestures loaded off disk. See [Motions](motions.md) |
| `--bgm` | `show/bgm` | The music library. See [Background music](bgm.md) |
| `--recordings` | `show/recordings` | Where a take is written. See [Recording](recording.md) |

Five environment variables, read by whichever process needs them:

| Variable | Read by | What it does |
|---|---|---|
| `HASHIDATE_CONTROL_PORT` | the native shell, `make dev`, `make stop` | The control port, where `--port` is not available |
| `HASHIDATE_VOICE_DIR` | `make voice`, the sidecar | Moves the reference clips and their encoded latents, including out of the repository |
| `HASHIDATE_TTS_SOCKET` | the control server, the sidecar | Where the voice answers. Both resolve it independently; neither is told by the other |
| `HASHIDATE_TTS_PORT` | the control server, the sidecar | Points the proxy at `127.0.0.1` on a port instead of a socket, for a stand-in written as an ordinary HTTP service. See [Speech](speech.md#using-a-different-voice) |
| `HASHIDATE_LOCALE` | everything | Pins `en` or `ja` for a run, between the built-in default and what the environment says |

Everything else about a broadcast is either standing state on the server — the avatar, the costume, the shot, the set, the acoustic, the tuning — or a property of one browser source, on that source's URL. See [The renderer's URL](surfaces.md#the-renderers-url) and [The standing state](surfaces.md#the-standing-state).

## Setting up the voice

For an audible character, put clips in `tools/tts/reference/clips/` and run `make voice` once — see [To produce audio](#to-produce-audio). After that, `make dev` brings the voice up with everything else, and `make tts` runs it on its own. Without it a line is mouthed silently on the timing the text implies, which is what the tests do. See [Speech](speech.md).

The control server prints what it found of the voice at startup and reports any change, and the panel carries the same warning. A sidecar that stops answering mid-broadcast is otherwise invisible, because the queue still drains and the mouth still moves.

## Using it with OBS

The renderer is on `/`, and it opens as the character and nothing else — no console, no HUD, no cursor. That URL is what a browser source is given:

```
http://127.0.0.1:8765/?size=1920x1080&backdrop=night
```

Add `?transparent=1` to drop the background and let OBS composite the character over a game capture instead. See [The stage](stage.md).

The panel composes that address above the tabs: pick the size, the set, the document and where the character stands, then copy the result.

`/monitor/` is the same renderer letterboxed to 16:9 with nothing around it. That page is the one meant to be listened to: a browser source sends its audio to the stream and not to the desk, so on an ordinary setup it is the only way to hear the character in the room.

## Checks

```sh
yarn typecheck
yarn lint          # biome
yarn test          # vitest
```

Tests build a synthetic avatar in code rather than loading a GLB, because a suite that needs a purchased 16 MB model can only run on a machine that has bought it. See `tests/helpers/scene.ts`.

The constants in `src/engine` were arrived at by watching two real avatars, and most carry a comment naming the failure they prevent. Changing one requires checking the result in a render.

## Next

- [Use cases](use-cases.md) — what to build with it
- [The control API](control-api.md) — the interface an orchestrator talks to
- [Commands](commands.md) — the full vocabulary
- [The native shell](shell.md) — running the whole thing as one application
