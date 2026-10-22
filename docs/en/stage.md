# The stage

The room the character is *seen* in, which is a separate axis from the room the character is heard in and deliberately not chained to it.

## The set

There are four — `dusk`, `night`, `morning`, `rain` — and they use one room lit four ways rather than four rooms: the shell, the window and most of the furniture are shared, and what differs is where the light comes from, its colour temperature, and where the brightest and darkest values fall in the frame. A backdrop has to hold up behind a face for two hours, so each is built to a value structure rather than to a colour scheme.

The room shell, lighting and surface textures — plaster, floorboards, woven cloth and what is outside the window — are generated procedurally at startup. The viewer can also load four local furniture GLBs: `gothic-bed.glb`, `gothic-commode.glb`, `sofa.glb` and `pillows.glb`. Those files are ignored by git and absent in a fresh clone, so the furniture is optional runtime data.

Set it on the URL, which is what a browser source in OBS is given:

```
http://127.0.0.1:8765/?size=1920x1080&backdrop=night
```

Same run modes as [Using it with OBS](getting-started.md#using-it-with-obs): `:8765` needs `yarn build` and `yarn start` (or `yarn shell`), and under `make dev` the address is `:5173`.

An unknown name renders the flat background rather than failing, because the URL is typed into a field with nowhere to report an error to. It is also a command, for changing the set mid-stream:

```sh
yarn ctl backdrop dusk
yarn ctl backdrop        # bare stage
```

A room also finishes the picture. What lies behind the character is blurred by depth, starting just past the far side of the character, so the furniture recedes while hair and hands stay sharp; then the frame is graded and its corners darkened, with values each room declares. Only a room does this. The flat colour, a transparent source and a document behind the character are drawn without it, because what happens to those is the compositor's business, and with bloom off they skip postprocessing entirely.

## Over a game

With no set, the character stands against a flat colour. That is a fallback rather than a design — a renderer opened in a browser window has to put something behind the character — and over a game capture it becomes a problem, because it is an opaque rectangle covering the thing the stream is about.

`?transparent=1` removes it, and the compositing is then OBS's.

```
http://127.0.0.1:8765/?transparent=1&place=bottom-right:0.32x0.6
```

Same run modes as [Using it with OBS](getting-started.md#using-it-with-obs): `:8765` needs `yarn build` and `yarn start` (or `yarn shell`), and under `make dev` the address is `:5173`.

A game or window capture below, that URL as a browser source above, and the character lands on it. `place` behaves as it does behind a document — the shot is untouched and the picture of it is smaller — and the empty side hangs off the frame and is clipped there.

A set still wins over transparency. A room is opaque geometry with its own background, and one chosen while transparency is on is an operator asking for the room.

Transparency is on the URL and deliberately not a command: what is underneath is a property of the OBS scene the source was dropped into, and no line of a script can know it. Capturing the game *into* the page is worse in the place it has to work, because the browser embedded in OBS has no way to grant a display-capture permission, so it would only ever run in a stray browser window, and it would take every frame of the game twice.

## Where the character stands in the frame

```sh
yarn ctl place avatar --anchor bottom-right --width 0.32 --height 0.6
```

That shrinks the *picture*, not the shot. The camera does not move, so every gesture still plays exactly as it was authored against its framing.

The rectangle is an **area**, and it deliberately does not decide the shot. A framing is a world-space top and bottom edge, so aiming it at a rectangle of another shape has to give something up, and both obvious answers are wrong:

- Filling the rectangle keeps the vertical and cuts the arms off both sides, where a raised hand and most of the hair are.
- Standing the camera back until the width fits crops nothing and grows the vertical by the same amount, so an upper-body shot quietly becomes a full-body one.

What is drawn instead is the frame's own shape, scaled to fit inside the area: the picture the whole frame would have shown, smaller and off to one side. What the area does not cover is transparent, so a document behind shows through it.

What lands on the anchor is the character rather than that picture. A framing is a wide picture with a narrow figure in the middle of it, so putting its edge on the frame's edge would leave the character a quarter of a frame short, standing in front of a large empty area. The empty side is pushed out past the edge and clipped there instead.

Only the tighter of the two fractions therefore decides anything for the character, and at `1` an anchor has nowhere to move to. The two fractions are mainly for the document, which has a `fit`. See [Slides](slides.md).

A layout can also ride on a line, under `stage.place`, which is how a script moves the character aside for a deck and back afterwards:

```yaml
- text: "[present]資料を出すこともできます。"
  stage:
    deck: hashidate
    slide: 1
    place:
      avatar: { anchor: bottom-right, width: 0.26, height: 0.54, margin: 0.015 }
```

Both belong on the same line. Sent as a separate command the layout lands at some other moment, and the frame is briefly wrong in the most visible way available — the character standing in the middle of the page being talked about. See [Scripts](scripts.md).

## Hiding the character, and moving it across its picture

```sh
yarn ctl place avatar --hide        # voice only
yarn ctl place avatar --show
yarn ctl place avatar --shift=-0.2  # a fifth of the picture to the left
```

`visible: false` stops drawing the character and nothing else. The model stays loaded and the session behind it goes on speaking, moving and lip-syncing out of sight, so a segment read in voice alone keeps its timing, and showing the character again brings it back mid-gesture. The room stays up. This is also how a script starts without the character and brings it in later.

`shift` moves the figure across its own picture, as a fraction of the picture's width, from −0.5 to 0.5; positive is to the right. It is a lens shift: the camera does not move or turn, so the framing and the gestures are unchanged, and a full-frame picture still covers the whole frame. That makes it the control for a full-frame character that should stand off-centre, where an anchor has nowhere to move to. In a corner the picture is already pulled so the figure stands on the frame's edge, so shifting it further toward that edge takes it out of frame.

Both are fields of the character's half of a layout, so they go wherever a layout goes — the panel's Slides tab, `stage.place` on a line, or a `[@place {JSON}]` cue part-way through one:

```yaml
- text: "ここからしばらく、声だけで話します。"
  stage:
    place:
      avatar: { visible: false }
- text: '[@place {"avatar":{"visible":true,"shift":-0.2}}]お待たせしました。'
```

A run started part-way through a script carries both, like the rest of the layout. Both also outlast the run that set them: a script that hides the character should show it again before it ends, or the next one starts without it.

## Bloom

Bloom adds a soft glow around bright areas of the rendered scene. It starts off. In the panel's **Tune** tab or the viewer console's **Tune** tab, enable **Bloom** and adjust its strength, radius and brightness threshold. Lower thresholds include more of the picture; higher strength makes white clothing and skin glow too.

```sh
yarn ctl bloom on
yarn ctl bloom on --strength 0.2 --radius 0.4 --threshold 0.85
yarn ctl bloom off
```

The API accepts the same settings as a partial command:

```json
{"cmd":"bloom","enabled":true,"strength":0.2,"radius":0.4,"threshold":0.85}
```

`strength` is 0..3, `radius` is 0..1, and `threshold` is 0..2. Omitted fields keep their values; switching off keeps the parameters for the next use. Settings are shared by the preview and stage, survive avatar changes, and are replayed to renderers that connect later. Recording captures the effect from the rendered canvas. Slide documents remain sharp because they occupy a separate layer.

MCP uses `stage` with `{"bloom":true}` or `{"bloom":false}`. A script can switch it for each line with `stage.bloom`; see [Scripts](scripts.md#bloom).

## Next

- [Slides](slides.md) — what else occupies this place
- [Speech](speech.md#the-room) — the other room, the one the character is heard in
