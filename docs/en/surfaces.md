# The surfaces

There are three pages, and the difference between them is not what they can do — it is where they stand.

## The panel, on `/panel/`

Where a broadcast is run. It holds no renderer and no `AudioContext`: every control goes out through the control API, which means a control that works there is a control a language model can drive.

Nine tabs — Queue (which script is loaded, the pending lines, the history, and rewinding into it), Recording (writing a take to a file), Perform, Voice, BGM, Slides, Dress, Tune, Inspect — with the avatar, the framing, the set and the idle switch under a preview, because those four are chosen by looking at the picture. The BGM tab lists `show/bgm/`, controls its transport and level, and keeps its libsonare effects separate from the spoken voice.

The preview *is* the camera control: drag to swing round the character, wheel to come in. The embedded viewer reads its own camera back and hands it up to the panel, which sends the ordinary `camera` command an orchestrator could have sent — so the renderer on air swings with it, and nothing about the shot lives in one page rather than the other.

The preview is silent, always. It is a second renderer of the same commands, and it asks for every line and plays every take so that its mouth runs on the clock the queue is actually on — into a gain of zero. Hearing it as well as the source going to air is every line twice, a fraction of a second apart, which is worse than hearing neither.

That silence is also what decides which page records. A take is what the room heard, so the renderer that is not muted is the one that writes it — see [Recording](recording.md).

Above the tabs is the one address OBS needs, composed rather than typed: size, set, document, where the character stands in the frame, and whether the background is transparent. What comes out is a `/?size=…` URL to paste into a browser source. Nothing about it is application state — OBS owns that setting the moment it is pasted there.

## The renderer, on `/`

The page OBS points at. It opens as the character and nothing else: no console, no HUD, no cursor, and a camera the pointer cannot move. A default that has to be switched off before going to air is a default that eventually goes to air.

`?console=1` brings back the operator console, which reaches *into* the live scene — `director.rig.measure('R')`, joint angles against their anatomical ranges, the resolved profile. That is a development instrument rather than a second control surface, and it is the answer to "why does that pose look wrong". (`?stage=1` is still accepted and now says nothing the default does not; it stays because it is written into browser sources configured before the default changed.)

## The renderer's URL

Everything a source is configured *as* rides on the address, because a browser source is a text field OBS reloads whenever it feels like it. Everything about the show, by contrast, lives in the server's standing state and is handed to a renderer the moment it attaches.

| Parameter | Value | Default | What it decides |
|---|---|---|---|
| `size` | `1920x1080` | fill the window | The render size in pixels. Match the source size configured in OBS, or the picture is resampled twice |
| `backdrop` | a set id | flat background | Which room the character is seen in. See [The stage](stage.md#the-set) |
| `transparent` | `1` | off | Draw nothing behind her, so OBS composites over a game capture. A set still wins over it |
| `deck` | a document id | none | Which document the source opens on. See [Slides](slides.md) |
| `place` | `bottom-right:0.32x0.6` | full frame | Where she stands in the frame, as an anchor and two fractions of it. See [The stage](stage.md#where-she-stands-in-the-frame) |
| `mute` | `1` | off | Whether this renderer makes a sound. See below |
| `console` | `1` | off | The operator console, the HUD and the cursor — one flag for all three, because they are one decision |
| `debug` | `1` | off | The measurement readout, as the renderer *opens*. The backquote key and the `debug` command move it afterwards |
| `stage` | `1` | — | Accepted and ignored. It says nothing the default does not |

Anything unparseable degrades rather than failing: an unknown set is the flat background, a bad `place` is the full frame, an oversized `size` fills the window. There is nowhere for a renderer to report an error to — the URL was typed into a field inside OBS — and nobody watching if there were, so a typo has to leave something that still streams.

Three of these are the panel's business too: the address above the tabs is composed from `size`, `backdrop`, `deck`, `place` and `transparent`, which is why the panel is where a browser source gets set up rather than a document to copy from.

`/monitor/` passes its own query string straight through to the viewer it holds, so all of these work there as well.

### Whether a renderer makes a sound is decided by its URL

`?mute=1` is the whole mechanism, and there is deliberately no command that silences a renderer without changing its address. A page that is quiet has to be quiet for a reason somebody can read off the bar.

It silences the **output and not the synthesis**. A muted renderer still asks for every line and still plays the take, into a gain of zero — skipping the request would put it on a different clock, with the mouth falling back to the text estimate and lines ending at moments they do not end at on air. A monitor that runs ahead of the thing it monitors is worse than no monitor.

Three consequences follow from that one flag:

- The panel's preview is opened muted, so an operator does not hear every line twice.
- The stage window is opened with or without it by `Window → Mute Stage`. See [The native shell](shell.md#mute-stage).
- The renderer that is **not** muted is the one that writes a recording. See [Recording](recording.md).

## The stage, on `/monitor/`

The same renderer, letterboxed to 16:9 and framed by nothing else — no console, no controls, no application around it. It is what an operator watches, and it is the one page in this project that is meant to be listened to: the browser source OBS opens sends its audio to the stream, and on an ordinary desk nobody in the room hears the character at all.

It ships none of the panel's code and none of the queue editor. What it holds is an iframe pointed at `/`, with the letterbox bars outside it, so the renderer receives the source's aspect ratio whatever shape the window is dragged into. Everything on its own address is passed straight through, `?mute=1` included — which is how it is silenced when OBS *is* monitoring the browser source and the room is therefore already hearing every line.

## The native shell

`yarn shell` builds the pages and opens two windows on them — the panel and the stage — with the control server and, if the checkout has one, the speech sidecar started underneath and stopped again on quit. A server already running on this checkout is used rather than replaced, so a `yarn dev` left up is not taken down; a server running on a *different* checkout is refused by name rather than adopted, because two windows quietly loaded from somebody else's build look exactly like a renderer that will not come up.

It is a convenience, not a fourth surface. Everything in it is the same three pages on the same loopback addresses, and everything it can do to the show it does through the same control API. What it adds is the things a browser cannot: the windows come back where they were left, the stage is allowed to start its audio without anybody having clicked the page first, and `Window → Mute Stage` decides whether this machine hears the character — the one question about a broadcast that no orchestrator and no line of script can answer, because it is about the desk rather than the show.

The menu, the status lines, where it writes its logs and what its windows are allowed to reach: [The native shell](shell.md).

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

The panel is the full surface and the renderer is opened last, at the top of the broadcast. That is only true because the control server keeps the setup: the avatar, the costume, the shot, the set, the acoustic, the voice chain, the BGM transport and the tuning are folded into a standing state as they are chosen, and handed to a renderer the moment it attaches — along with the pending queue, which is what has always made a reload survivable mid-stream.

Nothing about the show lives in the URL a browser source was configured with.

What is *not* replayed is anything that was a moment rather than a setting. A gesture ends on its own, an expression is released with the line that raised it, an interrupt has already happened; re-enacting those for a renderer joining an hour later would be the opposite of restoring a setup.

## Next

- [The native shell](shell.md) — the two of these it opens as windows
- [Recording](recording.md) — which of these pages writes the file
- [Architecture](architecture.md) — where the standing state lives
- [The control API](control-api.md) — what the panel is sending
