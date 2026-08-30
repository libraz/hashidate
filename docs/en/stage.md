# The stage

The room the character is *seen* in, which is a separate axis from the room the character is heard in and deliberately not chained to it.

## The set

There are four — `dusk`, `night`, `morning`, `rain` — and they use one room lit four ways rather than four rooms: the shell, the window and most of the furniture are shared, and what differs is where the light comes from, its colour temperature, and where the brightest and darkest values fall in the frame. A backdrop has to hold up behind a face for two hours, so each is built to a value structure rather than to a colour scheme.

The room shell, lighting and surface textures — plaster, floorboards, woven cloth and what is outside the window — are generated procedurally at startup. The viewer can also load four local furniture GLBs: `gothic-bed.glb`, `gothic-commode.glb`, `sofa.glb` and `pillows.glb`. Those files are ignored by git and absent in a fresh clone, so the furniture is optional runtime data.

Set it on the URL, which is what a browser source in OBS is given:

```
http://127.0.0.1:8765/?size=1920x1080&backdrop=night
```

An unknown name renders the flat background rather than failing, because the URL is typed into a field with nowhere to report an error to. It is also a command, for changing the set mid-stream:

```sh
yarn ctl backdrop dusk
yarn ctl backdrop        # bare stage
```

## Over a game

With no set, the character stands against a flat colour. That is a fallback rather than a design — a renderer opened in a browser window has to put something behind the character — and over a game capture it becomes a problem, because it is an opaque rectangle covering the thing the stream is about.

`?transparent=1` removes it, and the compositing is then OBS's.

```
http://127.0.0.1:8765/?transparent=1&place=bottom-right:0.32x0.6
```

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

## Next

- [Slides](slides.md) — what else occupies this place
- [Speech](speech.md#the-room) — the other room, the one the character is heard in
