# Packs

A pack lets someone who has bought an avatar use it with one command:

```sh
make import                                   # list the packs and where to buy each model
make import PACK=manuka PACKAGE=~/Downloads/MANUKA_ver1.02.zip
```

`make import` unpacks the package into `unpacked/<id>/`, a directory that ships empty and git-ignored, pulls out what the pack's `extract` steps name, puts the descriptor and export profile in `avatars/`, and runs `make textures` and `make glb`. The model itself never enters git: a pack holds only names and figures, never meshes, textures or shapes.

## Layout

```
packs/<id>/
  pack.json     where to buy the model, which packages were verified, how to unpack them
  avatar.json   the descriptor, as `avatars/<id>.json`
  export.json   the export profile, as `avatars/export/<id>.json`
```

The directory name is the avatar id. `avatar.json` and `export.json` are the formats described in [Avatars](../docs/en/avatars.md); `src/protocol/avatars.ts` is the reference for the first.

## pack.json

```json
{
  "store": "https://example.booth.pm/items/0000000",
  "packages": [
    { "file": "Example_1.0.0.zip", "sha256": "<64 hex digits>" }
  ],
  "extract": [
    { "from": "Example_1.0.0/Example.unitypackage", "match": "/FBX/", "into": "fbx" }
  ]
}
```

| Key | What it states |
|---|---|
| `store` | The `https://` page the model is sold from. |
| `packages` | Each package the pack was verified with: its file name and its SHA-256. A package not listed is imported with a warning. |
| `extract` | Steps run after the zip is unpacked, in order. Each pulls every texture and FBX file whose path inside the Unity project contains `match` out of the `.unitypackage` at `from`, into `into`. Both paths are relative to `unpacked/<id>/`. Empty when the zip carries the files directly. |

There is no other kind of step, and no step runs a script. Importing a pack must not run code its author wrote on the buyer's machine. If a package needs something these steps cannot express, add a kind of step to `tools/blender/import_pack.py` rather than shipping a script in the pack.

Every path in `export.json` that comes out of the package (`source`, `extras`, `textures_src`) is under `unpacked/<id>/`. The importer checks that each one exists after unpacking and refuses the package otherwise, which is what catches a wrong or renamed package.

## Writing one

1. Import the model by hand first, as [Building your own](../docs/en/avatars.md#building-your-own) describes, until `yarn ctl avatars` reports `nothing unresolved` and the avatar looks right on screen. The figures in the descriptor are tuned by eye; a pack is only worth publishing once they have been.
2. Make the export profile's paths match where the importer unpacks: the zip's contents under `unpacked/<id>/`, and each `extract` step's `into` beneath it.
3. Copy `avatars/<id>.json` to `packs/<id>/avatar.json` and `avatars/export/<id>.json` to `packs/<id>/export.json`. Fill in `author` in the descriptor; it is the credit the model's licence asks for.
4. Write `pack.json`. Take the hash with `shasum -a 256 <package.zip>`.
5. Check it:

   ```sh
   yarn vitest run tests/packs
   ```

   Then import it into a fresh clone with `make import`, from the package as downloaded, and confirm `yarn ctl avatars` still reports `nothing unresolved`.

## Before publishing a pack

- Read the model's terms. A pack is only useful for a model whose licence lets its buyer publish rendered video, and it must not ship anything the licence forbids redistributing.
- Leave out anything only your own copy has: local paths, outfits or accessories bought separately, edits made to the model in Blender.
- When the author releases a new version, verify the pack against it and add its file name and hash to `packages`. Keep the old entry while the old package still imports.
