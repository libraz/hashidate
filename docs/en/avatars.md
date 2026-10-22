# Avatars

The engine holds no avatar data. Everything that is a property of one particular model lives in a file under `avatars/`, and the runtime reads it through a profile. The control server validates the file and serves it, and the renderer builds the avatar from what it receives. Adding an avatar is adding a file; no code changes and nothing is registered.

**A fresh clone has no avatar in it.** `avatars/` and `public/models/` ship empty and git-ignored, so the first step with a checkout is to supply a model and describe it. See [Building your own](#building-your-own).

The reference for the format is `src/protocol/avatars.ts`: the schema that both the server and the renderer parse with. This page says what the fields are for; that file says what is well formed.

## Which model to start with

The quickest start is to buy a model that has a pack. A pack in `packs/<id>/` carries the descriptor and export profile the model was tuned with, so one command turns the purchased package into an avatar that behaves the way these pages describe, with nothing to adjust by eye. Two exist, for the two models every tuned number in the engine was set by watching:

| Pack | Model | Author | Where to get it | Face |
|---|---|---|---|---|
| `manuka` | Manuka ver1.02 | Jingo (STUDIO JINGO) | [BOOTH](https://jingo1016.booth.pm/items/5058077) | The author's own shape keys and no ARKit set, composed through `emotionShapes`. |
| `yoka` | Tabimakura Yoka 1.0.0 | Kotobukiya | [BOOTH](https://avatarchan.booth.pm/items/8217336), [official site](https://avatar.kotobukiya.co.jp/daminzoku/) | The ARKit 52 set plus drawn expressions, selected through `presets`. |

Between them they cover both kinds of face the engine tells apart. Both licences allow publishing rendered video and forbid redistributing the model data, modified or not. Read each author's terms before broadcasting; see also [Licensing](#licensing-is-why-the-runtime-is-loopback-only).

Any other humanoid with VRChat, Unity, VRM or Mixamo bone names loads as well, but expect to tune sway and expressions by eye. See [Building your own](#building-your-own), and `packs/README.md` for turning the result into a pack.

## Importing a pack

```sh
make import                                                    # the packs, and where to buy each model
make import PACK=manuka PACKAGE=~/Downloads/MANUKA_ver1.02.zip
make import PACK=yoka PACKAGE=~/Downloads/TabimakuraYoka_Avatar_1.0.0.zip
```

`make import` unpacks the zip into `unpacked/<id>/`, which is git-ignored, pulls the FBX files and textures out of any `.unitypackage` the pack names, puts the pack's descriptor and export profile in place as `avatars/<id>.json` and `avatars/export/<id>.json`, and runs `make textures` and `make glb`. Run it from the repository root. It refuses a package that lacks a file the export profile names, imports one whose hash the pack does not list with a warning, and overwrites nothing: to re-import, move aside `unpacked/<id>/` and any descriptor in `avatars/` that differs from the pack's.

The steps have been run on macOS with Blender 5.2 LTS and on no other platform: `make textures` resizes with the macOS `sips` tool, and `make glb` expects Blender at `/Applications/Blender.app` unless `BLENDER=<path>` says otherwise.

### Checking the result

```sh
make dev                     # in one terminal
yarn ctl avatar manuka       # in another
yarn ctl avatars             # the id is listed, nothing is rejected, nothing unresolved
yarn ctl vocab               # emotions, drawn expressions and wardrobe from the model
yarn ctl play demo --replace
```

Open `http://127.0.0.1:5173/` to see it; the renderer has to be open for `avatars` to report what it loaded, and it reads the avatar list when it connects, so reload the page after importing. Right after `avatar`, the report can still name the previous avatar or say `loading`; run `avatars` again until it names the one asked for. The import is done when `yarn ctl avatars` prints `loaded: manuka (ready) nothing unresolved` and the avatar stands, blinks and mouths the demo's lines. The unresolved report lists, by name, any bone, shape, wardrobe mesh, sway group or tail the descriptor names and the GLB lacks. For a pack it should be empty. A name in it means the package differs from the one the pack was verified with: look the name up in the descriptor and correct it against [Inspecting a model](#inspecting-a-model).

## Where the files go

```
avatars/<id>.json             what the runtime reads (.yaml and .yml are accepted too)
avatars/export/<id>.json      how the model is converted to a GLB; used by `make`, not by the runtime
public/models/<id>.glb        the model the viewer loads
```

The id is the filename without its extension. It is at most 64 characters, has no leading dot and contains no path separator or control character. Two filenames that differ only in Unicode normalisation are both rejected as ambiguous. A file larger than 256 KiB is rejected.

`--avatars <dir>` moves the directory, on the same footing as `--motions`. The files are not tracked by git. The native shell has `Window → Open Avatars Folder`.

## A minimal file

`avatars/example.json`, with its model at `public/models/example.glb`:

```json
{
  "label": { "en": "Example", "ja": "サンプル" },
  "separator": { "pattern": "^_{2,}(.+?)_{2,}$" },
  "presets": {
    "group": "Faces",
    "label": { "stripPrefix": "F_", "underscoresToSpaces": true }
  },
  "sway": {
    "groups": [{ "id": "hair", "label": { "en": "Hair", "ja": "髪" }, "stiffness": 0.4, "drag": 0.2, "childrenOf": ["Hair"] }]
  }
}
```

Only `label` is required. An avatar that states nothing else still loads, and whatever the engine cannot resolve on its own is reported by `yarn ctl avatars` rather than failing.

```sh
yarn ctl avatars
yarn ctl avatar example
yarn ctl vocab
```

`avatar` is the only command that replaces the session every other one talks to, so the renderer holds what arrives behind it until the model is standing: swap and dress in one batch behaves as written.

## Fields

Every object in a file is strict: an unknown key is an error naming its path, and so is a value of the wrong kind. `id` is such a key, because the filename is the id. Numbers must be finite.

| Field | What it states |
|---|---|
| `label` | The name shown in the pickers, as `{ "en", "ja" }`. Required. |
| `author` | Credit for the model, as `{ "en", "ja" }`. |
| `url` | Where the viewer fetches the GLB from. Defaults to `/models/<id>.glb`. See [url](#url). |
| `separator` | A [pattern](#patterns) matching the dummy shapes an author puts between shape groups, with the group name in its one capture group. |
| `gaze` | Measured eye, head and neck limits (`eyeYaw`, `eyePitch`, `headYaw`, `headPitch`, `neckYaw`, `neckPitch`). Any left out keep the engine's conservative defaults. |
| `shapes` | Names for blink (`blink.both`, `blink.L`, `blink.R`) and viseme slots that the engine's own candidate lists do not resolve. |
| `bones` | Bone names per slot (`hips`, `spine`, `chest`, `neck`, `head`, `eye.L`, `upperArm.R`, `toe.L` and so on), each a list. For a rig whose names no generic candidate list reaches. See [Bone names](#bone-names). |
| `fingers` | Finger chains by key (`thumb.L`, `index.R`, …), each a list of bone names with the proximal segment first. |
| `presets` | Finished whole-face drawings: `group` names the shape group, `exclude` lists fitting shapes that are not expressions, `emotion` maps canonical emotions to a drawing, `composition` says how a drawing shares the face with blink and speech, `hideGroup` names the group of parking shapes, `idleExclude` keeps faces away from the idle autopilot, and `label` is a [label rule](#labels). |
| `emotionShapes` | Emotion composition in the avatar's own shape names, for a model without ARKit shapes. |
| `mouthShapePattern` | A pattern for the shapes the mouth layer owns while speaking. |
| `overlays` | A drawn-shape group of effects over the face, with the same `group`, `exclude` and `label` as `presets`. |
| `materials` | `doubleSided`, `faceDecal`, `blendTransparent` and `preserveImported` as [patterns](#patterns) over material names, and `preservedPbrOverrides`, which sets `metalness`, `roughness` and optionally `reflection` for a named preserved material. `metalness` and `roughness` must lie in 0 to 1 and `reflection` may not be negative; a file outside those ranges is rejected with the path of the value. `toon` gives named materials the look their author set in lilToon; see [Toon materials](#toon-materials). |
| `wardrobe` | `slots`, each with `items` (`id`, `label`, `meshes`, `hide`), plus `presets` that set a slot to an item or to `null`, and a `note` shown above the slots. |
| `sway` | Secondary motion: `groups` with their figures and roots, and `colliders` sets that groups refer to by name. See [Sway tuning](#sway-tuning). |
| `drive` | `tail`: which sway group is posed rather than only simulated, with `swing`, `lift` and `rest`. |
| `script` | Demo turns, played by the viewer's script button. Each is a turn as the control API takes it. |
| `anatomy` | Joint table for an avatar that is deliberately not human. |
| `armRest` | Resting arm directions in character space, for a garment such as a full skirt that needs the arms held clear of the body. Slots left out keep the standing pose, and gestures blend from the declared one. |

`gaze`, `presets`, `emotionShapes`, `mouthShapePattern` and `overlays` accept `null`, which means the same as leaving them out. Writing it records that the model was looked at.

Two details sit inside sway groups and materials:

- `anchor` on a sway group attaches the group's root to a point weighted across bones that are already simulated, so a part of a garment follows the skin it sits on.
- `reflection` on a preserved PBR material sets how strongly it reflects the runtime's own studio environment. Without it the material sees only the scene environment, which is empty without a backdrop, and a metal draws dark.

### Bone names

For each slot the profile tries the names a file states, then its own generic candidates (VRChat, Unity, VRM and Mixamo families), and takes the first bone that exists. Stating a name overrides detection without disabling it. A finger chain is taken from `fingers` when its first two segments resolve; otherwise the generic finger patterns run.

```json
{
  "bones": { "upperArm.L": ["Arm_Left"], "chest": ["Torso"] },
  "fingers": { "index.L": ["IdxA_L", "IdxB_L", "IdxC_L"] }
}
```

**Names are matched after the loader's sanitisation.** The GLB loader rewrites every node name: whitespace becomes `_` and `[ ] . : /` are dropped. A bone or mesh exported as `Body.001` is `Body001` in the scene, and `Lace Trim` is `Lace_Trim`. Names in a file, including the generic candidates, go through the same rewrite before they are compared, so either spelling works. A leading `mixamorig` is also dropped, so `mixamorig:Hips` (`mixamorigHips` once loaded) matches `Hips`. The rewrite applies to bone names in `bones`, `fingers` and to wardrobe `meshes`. Shape names (`shapes`, `hide`, `emotionShapes`) are not rewritten by the loader and are compared as written.

When the GLB carries a VRM humanoid map, it is read as a `bones` override (and a `fingers` one): VRM 1.0 `VRMC_vrm.humanoid.humanBones` and VRM 0.x `VRM.humanoid.humanBones` both name the node for each humanoid bone, which is better evidence than any guess. Names a file states itself are still tried first.

VRoid shapes (`Fcl_MTH_A` to `Fcl_MTH_O` for the visemes, `Fcl_EYE_Close` and its `_L`/`_R` pair for blink) are among the generic candidates.

### Patterns

Wherever a field matches names, it takes an object rather than a string:

```json
{ "pattern": "^(Hair|Lash)", "ignoreCase": true }
```

`pattern` is a JavaScript regular expression source and `ignoreCase` is the only flag. A pattern may not be empty, may not be longer than 1024 characters and must compile. `separator` additionally needs exactly one capturing group; that group is the name of the shape group the separator opens.

### Labels

A label rule tidies a shape name for display:

```json
{ "stripPrefix": "F_", "underscoresToSpaces": true }
```

`stripPrefix` is removed once, and only from the start of the name. `underscoresToSpaces` then turns every `_` into a space. Both are optional, and no other key is accepted. The result is the author's own name for a drawing, so it reads the same in either language.

### Toon materials

`materials.toon` maps a GLB material name, spelled exactly, to the look its author set in lilToon. A material with an entry is drawn with it; one without is drawn as before. An empty `toon` changes nothing.

```json
"toon": {
  "Skin": {
    "shadow": { "color": [0.99, 0.92, 0.9], "border": 0.39, "blur": 0.26, "strength": 1, "normalStrength": 1 },
    "outline": { "width": 0.07, "color": [0.3, 0.2, 0.2, 1], "fixWidth": 0.5 }
  }
}
```

Only `shadow` is required, and inside a block every key is required except those marked optional with `?`. A block left out switches that feature off.

| Block | Keys | Meaning |
|---|---|---|
| `shadow` | `color`, `border`, `blur`, `strength`, `normalStrength`, `mask`? | The shade. `color` tints the albedo where the surface turns from the light, `border` and `blur` place and soften the edge, `strength` scales the shade (0 turns it off), and `normalStrength` sets how far the shade follows the normal map instead of the mesh normal. `mask` is a texture whose red channel scales `strength`. |
| `shadow2` | `color` (RGBA), `border`, `blur` | A second, darker band inside the shade. The alpha is how much of it shows. |
| `asUnlit` | number, 0 to 1 | How far the shade is lifted back toward the lit colour. Omitted is 0. |
| `normalMap` | `file`, `scale` | A normal map and its strength. A negative `scale` flips it. |
| `rimShade` | `color` (RGBA), `border`, `blur`, `fresnelPower`, `normalStrength` | A dark edge: along the silhouette the shaded colour is multiplied toward `color`, whose alpha is how much of it shows. `fresnelPower` is the exponent on the edge term, so higher is thinner, and `normalStrength` sets how far the edge follows the normal map. |
| `matcap` | `file`, `color` (RGBA), `blend`, `mode`, `shadowMask`, `enableLighting`, `mainStrength`, `normalStrength`, `backfaceMask`, `mask`? | A material-capture image lit onto the surface. `mode` is `normal`, `add`, `screen` or `multiply`. `shadowMask` dims it in the shade, `enableLighting` multiplies it by the light colour and `mainStrength` by the albedo, `normalStrength` sets how far the lookup follows the normal map, and a `backfaceMask` of 1 hides it on back faces. `mask` is a texture whose RGB scales the blend per channel. |
| `rim` | `color` (RGBA), `border`, `blur`, `fresnelPower`, `normalStrength`, `backfaceMask`, `shadowMask`, `mainStrength`, `enableLighting`, `mode`, `dirStrength`, `dirRange`, `indirRange`, `indirColor` (RGBA), `indirBorder`, `indirBlur`, `colorTex`? | A light edge, drawn after the matcap. `fresnelPower` is the exponent on the edge term, so higher is thinner. `dirStrength` confines the `color` band to the lit side and adds, by the same amount, a far-side band in `indirColor` placed by `indirBorder` and `indirBlur`; `dirRange` and `indirRange` widen their band toward 1 and narrow it toward -1. The other keys mean what they do for `matcap`. `colorTex` is a colour texture whose RGBA multiplies both bands' colours. |
| `emission` | `color`, `map`? | Light the material gives off, added to the lit colour. Channels may exceed 1. |
| `outline` | `width`, `color` (RGBA), `fixWidth`, `mask`? | A contour drawn behind the silhouette. `width` is in lilToon's unit, where 1 is a centimetre, `fixWidth` from 0 to 1 is how much the line thins as the camera comes within a metre of it, and `mask` is a texture whose red channel scales the width. |

Colours are sRGB as authored in lilToon, each channel 0 to 1, except that `emission.color` and the colour channels of `matcap.color` may go above 1. `dirRange` and `indirRange` lie in -1 to 1, `width` and `fresnelPower` may not be negative, `scale` may be any number, and every other number lies in 0 to 1. Any non-finite number is rejected, and so is an unknown key at any level.

A `file` is a bare filename such as `shade.png`: it may not be empty or contain `/`, `\`, `..`, `?` or `#`. The renderer fetches it from `/models/<id>/`, beside the model's GLB, and the files stay out of git with the rest of `public/models/`.

A name in `toon` may not also match `preserveImported`: the first replaces the material's look and the second keeps the imported one, so the file is rejected with the name.

### url

`url` is fetched from the viewer's own origin, so it has to be a root-relative path such as `/models/name.glb`. It may not start with `//`, contain `..`, `\`, `?` or `#`, or carry a scheme. A remote model is not expressible, which is deliberate: see [Licensing](#licensing-is-why-the-runtime-is-loopback-only).

### YAML

The same fields can be written as `.yaml` or `.yml`. A YAML file can carry comments, which is the reason to choose it: a note on why a figure has the value it has stays beside the figure. JSON is the form the examples use.

## Errors

A file that does not parse is dropped on its own; the other avatars stay available. The server reads the directory on every request, so a file saved while the stream is running appears at the next stream open. An avatar already loaded is not reloaded when its file changes.

```sh
yarn ctl avatars
```

lists each avatar found with its label and `url`, and the files that were rejected beside them, each with the reason and the path of the offending key. The renderer writes the same reasons to the browser console as warnings when it fetches the list.

Below the list comes the avatar a renderer has loaded, as `loaded: <id> (<phase>)`. A ready one is followed by `nothing unresolved`, or by `unresolved:` and a line for each layer that could not find what it looked for: the profile (bones, visemes, blink shapes), the wardrobe, the sway chains and the tail drive. Each line names what is absent. A failed one carries the load error. The same report reaches `GET /api/state` as `avatar.problems`.

With no avatar in the directory the stage stays empty, and the console shows a note in place of the picker.

## The vocabulary is discovered from the model

What the model can be asked for is resolved from what it actually ships: bones, finger families, visemes, blink shapes, drawn-expression groups, wardrobe meshes. ARKit support is detected, not assumed.

`GET /api/vocabulary` is therefore a report on the model rather than a constant. Two models by different authors, one implementing the ARKit 52 blendshape set and one implementing none of it, are driven by the same engine over the same command vocabulary, which is the claim this repository tests.

## Standing legs

The profile resolves optional `upperLeg`, `lowerLeg`, `foot`, and `toe` slots on both sides, using VRChat, Unity, or VRM bone names. Foot planting requires both complete hip-to-ankle chains in a standing rest pose; toes are optional. The core links must be direct parent-child chains below the hips, with uniform scales on the controlled bones. Nonuniform root or armature scale is supported. Rigs without these chains, seated rest poses, and avatars with an anatomy override retain their authored lower-body pose.

For supported standing rigs, the feet keep their rest positions and orientations relative to the avatar root during breathing and weight shifts. The knees absorb a lower pelvis, and the pelvis is lowered when an upward offset would otherwise stretch a leg. Hops lift both foot anchors by the airborne rise and plant them again for the landing dip. The solver rotates the leg bones without changing their local translations or scales. It runs before arm reaches and secondary motion.

## Wardrobe

Slots, presets and the hide-shapes that go with them, read from the model's meshes:

```sh
yarn ctl wear --slot outer none
yarn ctl wear --preset casual
```

## Sway tuning

Hair, a skirt hem, a ribbon and a tail are bones with no animation of their own. Their configuration lives in the authoring tool and does not survive export, so the bones arrive in the GLB and the numbers describing how they move have to be restated in `sway`.

Where the package exposes the author's own physics settings, carry those figures over. Someone chose them while watching the model move, so they are the better starting point, but they were chosen for another solver and are still checked against a render here. Where there are none, tune by eye: one group at a time, against a render, until the motion reads as cloth or hair and not as a rod.

### Anchoring a group to the skin

`anchor: { "source": "bone-metadata" }` takes the anchor from the group's root bone instead of from the file. The group must have exactly one explicit root in `roots` and no `childrenOf`. The anchor is a custom property named `skinPointAnchor` on that bone in the authoring tool, written out as glTF extras (the Blender exporter needs custom properties exported), and it holds an object of this shape:

```json
{
  "influences": [
    { "bone": "Spine_Upper", "weight": 0.7, "position": [0.0, 0.12, -0.03] },
    { "bone": "Hips", "weight": 0.3, "position": [0.0, 0.31, -0.02] }
  ]
}
```

One to four influences; each `bone` names a bone that resolves uniquely and is neither the root nor below it, `weight` is not negative and the weights sum to one, and `position` is the skin point transformed by that bone's inverse bind matrix. A group whose root lacks the property, or whose anchor fails these checks, is left out and reported in the profile's missing list. The same object can be written inline as `anchor` instead.

Either way the result is judged on screen. The engine's own constants were arrived at the same way, which is why a value is not changed to satisfy a test.

## Building your own

The engine is a runtime, not an editor. Rigging, weighting and garment authoring happen in Blender, and `tools/blender` is the interface between the two. A model that comes out of that pipeline needs one file in `avatars/`, as above.

Starting from whichever pack is closer saves most of the work: `packs/yoka/` for a model with the ARKit set and drawn expressions, `packs/manuka/` for one with only its own shape keys. The order is the one the sections below follow:

1. Inspect the model, to find its separator, its shape groups, its meshes and its materials.
2. Write the export profile and run `make textures` and `make glb`.
3. Write a descriptor with `label` alone, load it, and read what `yarn ctl avatars` reports as unresolved.
4. Add fields until that report is empty, then tune emotions, sway and gaze by watching the render.

The last step cannot be checked from the command line. A value that reads well on screen is the only test, which is why the packs carry figures rather than defaults. Once it looks right, `packs/README.md` says how to publish the result as a pack.

### Inspecting a model

Two headless Blender scripts report what a package contains before anything is written:

```sh
blender -b -P tools/blender/inspect_fbx.py -- <model.fbx>
blender -b -P tools/blender/inspect_shapekeys.py -- <model.fbx|model.blend> [out.txt]
```

`inspect_fbx.py` lists the armatures with their bone counts, every mesh with its vertex, triangle, material and shape key counts, and the materials and images; the mesh and material names are what `wardrobe`, `materials` and `texture_by_material` refer to. `inspect_shapekeys.py` counts shape keys per mesh and scores them against the ARKit 52 set, the VRChat visemes and the common MMD expressions, which decides which example to start from. With `out.txt` it also writes every shape key name in order, so the separator shapes and the groups under them can be read off for `separator` and `keep_groups`.

### Converting a model to a GLB

The conversion is described by an export profile at `avatars/export/<id>.json`, and two make targets read it:

```sh
make glb AVATAR=example        # FBX or blend → public/models/example.glb, plus the toon textures
make textures AVATAR=example   # original PNGs, subdirectories included → web-sized PNGs
```

`make` with no target lists what is available. `BLENDER=<path>` points `make glb` at another Blender binary. Both targets stop with a usage message when `AVATAR` is missing or when the profile does not exist.

The profile is a JSON object. Paths in it are relative to the repository root, where `make` runs.

| Key | What it states |
|---|---|
| `source` | The FBX or `.blend` to export. A `.blend` is preferred when the vendor ships one, because its materials arrive already wired to their textures. |
| `extras` | Further FBX files, such as an outfit, merged onto the main skeleton. Optional. |
| `textures` | The directory the export reads textures from. |
| `textures_src` | The directory of original textures that `make textures` copies from, subdirectories included. Optional. |
| `resize` | A list of `{ "match": "<glob>", "px": <n> }`. The first entry whose glob fits the file name sets its longest side; other files get 1024. Optional. |
| `separator` | A regular expression, as a plain string, matching the author's group-delimiter shape and capturing the group name. |
| `keep_groups` | The shape groups to keep. |
| `keep_groups_by_mesh` | Groups to keep on one mesh only: an object of lists keyed by mesh name. Optional. |
| `keep_names` | A pattern for loose shapes to keep that sit above no separator. Without it, a name containing `Hide` is kept. Optional. |
| `texture_by_material` | A material name mapped to the texture file in `textures` it should use. Optional. |

`make textures` resizes with `sips`, so it runs on macOS. It walks `textures_src` recursively and writes every file flat into `textures` as `<stem>.png`, so two files with the same stem anywhere under it stop the run, and the error lists them. If that happens, point `textures_src` at a narrower directory.

After the export, `make glb` copies the textures that `materials.toon` in `avatars/<id>.json` names, such as masks, normal maps and matcaps, from `textures` into `public/models/<id>/`, which is where the renderer fetches them. With no descriptor, or none that names a file, it prints `toon textures: nothing to copy` and carries on. If a named file is not in `textures`, it lists every one that is missing and fails; the usual cause is a texture outside `textures_src`, or `make textures` not run yet.

### Why shape groups are kept or dropped

Commercial avatars ship many shape keys, a large share of them fitting and utility shapes for the author's own tooling. Exporting all of them makes a heavy GLB and a vocabulary full of names that mean nothing on stage. The export therefore keeps by group.

Shape keys come in labelled groups, each opened by a dummy separator shape. The profile's `separator` finds those, and `keep_groups` names the groups worth having: the standard blendshape sets, the author's own expression drawings, and the group of parking shapes an outfit raises to keep the body from poking through it. The separators are kept as well, so the runtime can rediscover the grouping from the GLB alone, which is why the descriptor's `separator` and `presets.group` can be stated in the same names.

Filtering by group, instead of by name, is what lets an avatar's own expression vocabulary through: an authored face has no naming convention that identifies it from outside. A mesh with a few loose keys above no separator falls back to the standard names, plus `keep_names`.

Drop a group when nothing would ask for its shapes by name: fittings for other bodies, and variants of garments that are not exported. Keep a group when anything in `presets`, `wardrobe.hide` or `shapes` refers to its shapes, because a name that is not in the GLB is reported as missing.

### Unpacking a purchased package

Unpacking is not automated, because packages differ in shape. The steps are the same in outline:

1. Unzip the archive into a directory outside git. Everything under `backup/` and `public/models/` is ignored.
2. Find the FBX files and, if there is one, the `.blend`. Put their paths in the profile's `source` and `extras`.
3. For a `.unitypackage`, which is a gzip-compressed tar, pull the textures and FBX files out with `python3 tools/blender/extract_textures.py <package> <outdir> [path substring]`. The substring filters the paths inside the Unity project and defaults to `/Texture_1K/`. Point `textures_src` and `source` at the results. Masks and normal maps often sit in subdirectories of the package, so check that the substring takes them in.
4. Run `make textures AVATAR=<id>` and then `make glb AVATAR=<id>`.
5. To bring over the look the author set, run `lil_materials.py` as the next section describes and put its output in the descriptor. Run `make glb` again afterwards so the textures it names are copied.

`make check-assets` fails if anything over 1 MB has found its way into git. It runs against what git is actually tracking rather than against a list of paths, because a `.gitignore` only covers the paths someone thought of and a single half-gigabyte blob in the history is permanent.

### Reading the look from a Unity package

A `.unitypackage` that ships lilToon materials carries the author's shading as numbers, and `lil_materials.py` turns them into the `materials.toon` described above, so nothing is tuned by eye:

```sh
python3 tools/blender/lil_materials.py <package.unitypackage> \
  --folder /Materials/ --glb public/models/<id>.glb \
  --map mt_Outer_doubleS=Outer_double > toon.json
```

It uses only the Python standard library and prints `{"toon": {...}}` on stdout, to be pasted into the descriptor's `materials`. Everything else goes to stderr.

| Option | Meaning |
|---|---|
| `--folder` | A substring of the Unity path. Only the `.mat` files whose path contains it are read, so use it to leave out materials of another shader. Two `.mat` files of the same name under it are an error. |
| `--glb` | The exported model. Its material names, read from the GLB, are the keys of the output. |
| `--map` | `<glb material>=<mat name>`, repeatable, for a material whose name differs. Without it a GLB material takes the `.mat` of the same name, or the one named without a `mt_` prefix. |

The shader of each material is recognised by its guid. A variant with an outline pass gets an `outline` block; a guid that is not a lilToon variant stops the run with the material's name, which is why another shader's folder has to be left out with `--folder`. Textures are named by the stem of their path in the package plus `.png`, the name `make textures` gives them.

On stderr, a line starting with `unmatched:` is a GLB material with no `.mat`, or a `.mat` with no GLB material; the first is drawn as before, the second is dropped. A line starting with `warning:` names a material and a setting it uses that the renderer does not reproduce: a shadow border colour, a third shadow, an outline texture that differs from the base texture, backlight, a second matcap, second and third main textures, glitter, anisotropy, a shadow colour texture, a rim shade mask, a rim that fades with a transparent material's alpha, a matcap with its own normal map, or a blurred matcap (`_MatCapLod`). The look still imports; the warning says it will differ from the author's render.

## Checking the look

`yarn look` renders every avatar through the same shots and stages, so two versions of the look can be compared on the same frame:

```sh
yarn look --label before
# change something, then
yarn look --label after --compare before
```

It writes `backup/look/<label>/`: one PNG per avatar, shot and stage (`<avatar>-<shot>-<stage>.png`), and an `index.html` laying them out in a table. The directory is under the ignored `backup/` because each frame is a render of a purchased model, and a label that already exists is refused. `--avatars yoka,manuka` picks the avatars, and `--compare <label>` puts that earlier run beside each frame in the table; it links to the files and does not copy them.

It does not use a running `make dev`. It starts its own control and viewer servers on free ports bound to `127.0.0.1`, and stops them when it finishes, so it is safe to run while `make dev` is up. Frames are for the eye: the pose idles, so they are never equal pixel for pixel. It exits non-zero if a shader fails to compile, or if a transparent frame is not transparent where it must be.

## Licensing is why the runtime is loopback-only

Commercial models are typically not licensed for republishing. The viewer and the control API bind to `127.0.0.1` and send no CORS header **because of that**, not out of caution. The speech sidecar goes further and binds no port at all — a UNIX socket in a directory only its own user can enter — for a second and stronger reason: the voice is cloned from recordings of a real person. It can do that because its only caller is the control server proxying for the renderer.

There is no `--host` flag, no CORS header and no tunnel. If exposing the renderer ever becomes necessary, it is a licensing decision first and a code change second.

Nothing under `avatars/` or `public/models/` is covered by this repository's licence. A checkout provides the runtime, not the characters it runs.

Tests build a synthetic avatar in code rather than loading a GLB, because a suite that needs a purchased 16 MB model can only run on a machine that has bought it. Extend `tests/helpers/scene.ts` rather than adding a fixture.

## Next

- [Architecture](architecture.md) — where the descriptor is read
- [The control API](control-api.md#what-comes-back) — the vocabulary object
