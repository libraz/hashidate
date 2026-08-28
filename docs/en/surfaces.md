# The surfaces

There are three pages, and the difference between them is not what they can do — it is where they stand.

## The panel, on `/panel/`

Where a broadcast is run. It holds no renderer and no `AudioContext`: every control goes out through the control API, which means a control that works there is a control a language model can drive.

Seven tabs — Queue (the script, its history, and rewinding into it), Perform, Voice, Slides, Dress, Tune, Inspect — with the avatar, the framing, the set and the idle switch under a preview, because those four are chosen by looking at the picture.

The preview *is* the camera control: drag to swing round the character, wheel to come in. The embedded viewer reads its own camera back and hands it up to the panel, which sends the ordinary `camera` command an orchestrator could have sent — so the renderer on air swings with it, and nothing about the shot lives in one page rather than the other.

The preview is silent, always. It is a second renderer of the same commands, and it asks for every line and plays every take so that its mouth runs on the clock the queue is actually on — into a gain of zero. Hearing it as well as the source going to air is every line twice, a fraction of a second apart, which is worse than hearing neither.

Above the tabs is the one address OBS needs, composed rather than typed: size, set, document, where the character stands in the frame, and whether the background is transparent. What comes out is a `/?size=…` URL to paste into a browser source. Nothing about it is application state — OBS owns that setting the moment it is pasted there.

## The renderer, on `/`

The page OBS points at. It opens as the character and nothing else: no console, no HUD, no cursor, and a camera the pointer cannot move. A default that has to be switched off before going to air is a default that eventually goes to air.

`?console=1` brings back the operator console, which reaches *into* the live scene — `director.rig.measure('R')`, joint angles against their anatomical ranges, the resolved profile. That is a development instrument rather than a second control surface, and it is the answer to "why does that pose look wrong". (`?stage=1` is still accepted and now says nothing the default does not; it stays because it is written into browser sources configured before the default changed.)

## The stage, on `/monitor/`

The same renderer, letterboxed to 16:9 and framed by nothing else — no console, no controls, no application around it. It is what an operator watches, and it is the one page in this project that is meant to be listened to: the browser source OBS opens sends its audio to the stream, and on an ordinary desk nobody in the room hears the character at all.

It ships none of the panel's code and none of the queue editor. What it holds is an iframe pointed at `/`, with the letterbox bars outside it, so the renderer receives the source's aspect ratio whatever shape the window is dragged into. Everything on its own address is passed straight through, `?mute=1` included — which is how it is silenced when OBS *is* monitoring the browser source and the room is therefore already hearing every line.

## The native shell

`yarn shell` builds the pages and opens two windows on them — the panel and the stage — with the control server and, if the checkout has one, the speech sidecar started underneath and stopped again on quit. A server already running on this checkout is used rather than replaced, so a `yarn dev` left up is not taken down; a server running on a *different* checkout is refused by name rather than adopted, because two windows quietly loaded from somebody else's build look exactly like a renderer that will not come up.

It is a convenience, not a fourth surface. Everything in it is the same three pages on the same loopback addresses, and everything it can do to the show it does through the same control API. What it adds is the things a browser cannot: the windows come back where they were left, the stage is allowed to start its audio without anybody having clicked the page first, and `Window → Mute Stage` decides whether this machine hears the character — the one question about a broadcast that no orchestrator and no line of script can answer, because it is about the desk rather than the show.

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
