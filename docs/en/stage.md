# The stage

The room the character is *seen* in, which is a separate axis from the one she is heard in and deliberately not chained to it.

## The set

Four of them — `dusk`, `night`, `morning`, `rain` — and they are one room lit four ways rather than four rooms: the shell, the window and most of the furniture are shared, and what differs is where the light comes from, its colour temperature, and where the brightest and darkest values fall in the frame. A backdrop has to hold up behind a face for two hours, so each is built to a value structure rather than to a colour scheme.

None of it is a model file. The geometry is written out and the surfaces — plaster, floorboards, woven cloth, what is outside the window — are generated into a canvas at startup. Nothing to license, nothing to redistribute, and a wall whose mottling can be reviewed in a diff.

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

With no set, the character stands against a flat colour. That is a floor rather than a design — a renderer opened in a browser window has to put something behind her or it is a checkerboard — and over a game capture the floor is the problem: an opaque rectangle covering the thing the stream is about.

`?transparent=1` takes it away, and then the compositing is OBS's.

```
http://127.0.0.1:8765/?transparent=1&place=bottom-right:0.32x0.6
```

A game or window capture below, that URL as a browser source above, and the character lands on it. Everything `place` does is the same as it is behind a document — the shot is untouched and the picture of it is smaller — and the empty side hangs off the frame and is clipped there.

A set still wins. A room is opaque geometry with its own background, and one chosen while this is on is an operator asking for the room.

It is on the URL and deliberately not a command. What is underneath is a property of the OBS scene the source was dropped into, and no line of a script can know it. Capturing the game *into* the page was the alternative and is worse in the place it has to work: the browser embedded in OBS has no way to grant a display-capture permission, so it would only ever run in a stray browser window, and it would take every frame of the game twice.

## Where she stands in the frame

```sh
yarn ctl place avatar --anchor bottom-right --width 0.32 --height 0.6
```

That shrinks the *picture*, not the shot. The camera does not move, so every gesture still plays exactly as it was authored against its framing.

The rectangle is an **area**, and it deliberately does not decide the shot. A framing is a world-space top and bottom edge, so aiming it at a rectangle of another shape has to give something up, and both obvious answers are wrong:

- Filling the rectangle keeps the vertical and cuts the arms off both sides, where a raised hand and most of the hair are.
- Standing the camera back until the width fits crops nothing and grows the vertical by the same amount, so an upper-body shot quietly becomes a full-body one.

So what is drawn is the frame's own shape, scaled to fit inside the area — the picture the whole frame would have shown, smaller and off to one side. What the area does not cover is transparent, so a document behind shows through it.

What lands on the anchor is the character rather than that picture. A framing is a wide picture with a narrow figure in the middle of it, so putting its edge on the frame's edge would leave the character a quarter of a frame short, standing in front of a large piece of nothing. The empty side is pushed out past the edge and clipped there instead.

Which means only the tighter of the two fractions decides anything for the character, and at `1` an anchor has nowhere to move to. The two fractions are really for the document, which has a `fit`. See [Slides](slides.md).

## Next

- [Slides](slides.md) — what else occupies this place
- [Speech](speech.md#the-room) — the other room, the one she is heard in
