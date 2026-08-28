# Avatars

The engine holds no avatar data. Everything that is a property of one particular model lives in a descriptor under `src/avatars`, and the runtime reads it through a profile. Adding an avatar is adding a file.

**A fresh clone has no avatar in it.** The descriptors here point at `public/models/<id>.glb`, which is git-ignored, so the first thing to do with a checkout is supply a model. See [Building your own](#building-your-own).

```sh
yarn ctl avatar manuka
yarn ctl vocab
```

`avatar` is the only command that replaces the session every other one talks to, so the renderer holds what arrives behind it until the model is standing: swap and dress in one breath does what it reads like.

## Discovered rather than declared

What the model can be asked for is resolved from what it actually ships — bones, finger families, visemes, blink shapes, drawn-expression groups, wardrobe meshes. ARKit is detected, not assumed.

That is why `GET /api/vocabulary` is a report on the model rather than a constant. Two models by different authors, one implementing the ARKit 52 blendshape set and one implementing none of it, are driven by the same engine over the same command vocabulary — which is the claim this repository exists to test.

## Wardrobe

Slots, presets and the hide-shapes that go with them, read from the model's meshes:

```sh
yarn ctl wear --slot outer none
yarn ctl wear --preset casual
```

## Assets

The two validation avatars are purchased VRChat models. Their source packages, the extracted meshes and textures, and the GLB the viewer loads are all git-ignored: they are 1.5 GB together, and they are not ours to redistribute.

The pipeline turns a purchased package into a GLB:

```sh
make            # what each target does
make extract    # unpack a purchased archive
make textures   # unitypackage   → PNG
make resize     # 4K             → web-sized
make glb        # FBX            → public/models/*.glb
```

`make check-assets` fails if anything over 1 MB has found its way into git. It runs against what git is actually tracking rather than against a list of paths, because a `.gitignore` only covers the paths someone thought of and a single half-gigabyte blob in the history is permanent.

## Licensing is why the runtime is loopback-only

The avatars used for validation are commercial models that may not be republished. The viewer and the control API bind to `127.0.0.1` and send no CORS header **because of that**, not out of caution. The speech sidecar goes further and binds no port at all — a UNIX socket in a directory only its own user can enter — for a second and stronger reason: the voice is cloned from recordings of a real person. It can afford to, because its only caller is the control server proxying for the renderer.

There is no `--host` flag, no CORS header and no tunnel. If exposing the renderer ever becomes necessary, it is a licensing decision first and a code change second.

Nothing under `public/models/` is covered by this repository's licence. A checkout gives you the runtime, not the characters it was built against.

## Building your own

The engine is a runtime, not an editor. Rigging, weighting and garment authoring happen in Blender, and `tools/blender` is the seam between the two. A model that comes out of that pipeline needs a descriptor in `src/avatars` and nothing else.

Tests build a synthetic avatar in code rather than loading a GLB — a suite that needs a purchased 16 MB model can only run on a machine that has bought it. Extend `tests/helpers/scene.ts` rather than adding a fixture.

## Next

- [Architecture](architecture.md) — where the descriptor is read
- [The control API](control-api.md#what-comes-back) — the vocabulary object
