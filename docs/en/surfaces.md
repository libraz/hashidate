# Two surfaces

There are two pages, and the difference between them is not what they can do — it is where they stand.

## The panel, on `/panel/`

Where a broadcast is run. It holds no renderer and no `AudioContext`: every control goes out through the control API, which means a control that works there is a control a language model can drive.

Seven tabs — Queue (the script, its history, and rewinding into it), Perform, Voice, Slides, Dress, Tune, Inspect — with the avatar, the framing, the set and the idle switch under a preview, because those four are chosen by looking at the picture.

The preview *is* the camera control: drag to swing round the character, wheel to come in. The embedded viewer reads its own camera back and hands it up to the panel, which sends the ordinary `camera` command an orchestrator could have sent — so the renderer on air swings with it, and nothing about the shot lives in one page rather than the other.

## The renderer, on `/`

The page OBS points at. It opens as the character and nothing else: no console, no HUD, no cursor, and a camera the pointer cannot move. A default that has to be switched off before going to air is a default that eventually goes to air.

`?console=1` brings back the operator console, which reaches *into* the live scene — `director.rig.measure('R')`, joint angles against their anatomical ranges, the resolved profile. That is a development instrument rather than a second control surface, and it is the answer to "why does that pose look wrong". (`?stage=1` is still accepted and now says nothing the default does not; it stays because it is written into browser sources configured before the default changed.)

## The readout

`?debug=1` is the other thing a renderer will draw, and the one that may be brought up over a frame that is on air: the measurements — breath, blink, gaze, frame rate, which document is up and whether its page has finished drawing — printed as a shell in the corner, above the document layer so a slide segment does not hide them. It only reads, which is what makes it safe there. The backquote key toggles it, which is how it is actually used: switched on to answer a question and off again a few seconds later.

It is also a command, because the question it answers is usually about the picture going to air rather than about the page in front of you:

```sh
yarn ctl debug          # on, over every renderer attached
yarn ctl debug off
```

The panel has it on the measure button above the preview, and the preview then shows the readout because the preview is a second renderer of the same commands.

**It is the one standing-looking setting that is deliberately never kept.** Everything else that outlives a turn — the avatar, the costume, the shot, the set, the acoustic — is folded into the setup a renderer is handed the moment it attaches. This is excluded from that on purpose: a readout raised to answer a question during rehearsal would otherwise come back by itself on the source OBS reloads at the top of the broadcast, which is the one way a debugging tool ends up on a stream. Off is what a fresh renderer is, always.

## The standing state

The panel is the full surface and the renderer is opened last, at the top of the broadcast. That is only true because the control server keeps the setup: the avatar, the costume, the shot, the set, the acoustic, the voice chain and the tuning are folded into a standing state as they are chosen, and handed to a renderer the moment it attaches — along with the pending queue, which is what has always made a reload survivable mid-stream.

Nothing about the show lives in the URL a browser source was configured with.

What is *not* replayed is anything that was a moment rather than a setting. A gesture ends on its own, an expression is released with the line that raised it, an interrupt has already happened; re-enacting those for a renderer joining an hour later would be the opposite of restoring a setup.

## Next

- [Architecture](architecture.md) — where the standing state lives
- [The control API](control-api.md) — what the panel is sending
