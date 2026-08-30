# Commands

Every command goes to `POST /api/command`, one at a time or several under `batch`. `yarn ctl <command>` is the same thing from a terminal.

| Command | What it does |
|---|---|
| `perform` | A named face and movement. No id releases the one that is up. `side` names the hand its movement uses. |
| `say` | Queue a turn. Takes a `perform`, or the parts spelled out, or cues written into the text itself. The legacy `[performanceId]` shorthand and typed `[@perform]`, `[@expression]`, `[@gesture]`, `[@hop]`, `[@camera]`, `[@slide]`, and `[@bgm]` forms are available. `hold` keeps the face up past the line. `reading` gives the kana pronunciation where the writing does not determine it, and carries no cues of its own. `side` names the hand. `stage` names the shot. |
| `emotion` | The persistent mood, as a blend rather than a choice. |
| `expression` | One of the avatar's own drawn faces. `null` hands the face back to the emotion. |
| `overlay` | A drawn effect, at a weight. It layers over whatever face is showing, so several can be up at once. |
| `gesture` | One movement from the gesture table. No id stops it. `side` names the hand. |
| `hop` | A run of hops. Its own command rather than a gesture because it translates the whole skeleton, and runs alongside whatever the arms are doing. |
| `point` | Aim a fingertip at a bearing — degrees on the wire, and any of the five fingers. Held until released. |
| `look` | How much the gaze tracks the camera, 0 to 1. |
| `idle` | The autopilot, on or off. |
| `camera` | Where the camera stands: a framing — `face`, `bust`, `upper`, `full` — and how far off it, as a yaw, a pitch and a zoom. The offsets are relative to the framing so they survive an avatar swap, and every field is optional: naming a shot does not straighten one somebody tilted. |
| `room` | The space the voice is heard in. No id is dry. Persistent, like the camera. |
| `backdrop` | The room the character is seen in. No id is the flat background. A separate axis from `room` — a set can be cut without the microphone appearing to move. |
| `deck` | The document she is presenting from, by filename. No id takes it down. It occupies the same place as a backdrop, so the set is put away while one is up and restored when it comes down. |
| `slide` | Turn a page. `page` is absolute, `by` is relative, and a bare `slide` is next. Past either end is clamped rather than refused. |
| `place` | Where the character stands in the output frame and where the document sits behind her, each as a rectangle of it. Not the camera: the shot is untouched and the picture of it is moved, so the gestures still play as authored. Also rides on a line under `stage.place`, which is how a script moves her aside for a deck and back. |
| `wear` | One slot to an item, or a whole preset at once. |
| `avatar` | Load a different character. The only command that replaces the session every other one talks to, so the renderer holds what arrives behind it until the model is standing — swap and dress in one breath does what it reads like. |
| `tune` | The set-once layer: breath, sway, jump, tail, shading. Every field optional and merged onto what is running, so one fader is one small message. Bounded, unlike `point` — a breath period of zero is not an ambitious breath. |
| `debug` | The measurement readout, over every renderer attached. The one standing-looking setting that is deliberately never kept. |
| `record` | Start or stop writing the composed frame to a file, at a size the command names. Only the renderer that is not muted acts on it. |
| `bgm` | Select, play, pause or stop an MP3/FLAC from the configured BGM library; independently patch its level, looping, crossfade durations (0..10 seconds) and BGM-only libsonare effects. Different-track play crossfades the old and new tracks; the first/stopped play fades in only, while pause/resume/stop are immediate. The server keeps its transport in sync across renderers. The transport actions are also available as inline `[@bgm ...]` cues in a line, using the current fade settings. |
| `pause` | Hold the queue where it is, or let it move again. The line on air finishes and nothing is discarded — it is the third thing that can be done to a run of turns, and the only one that keeps them. |
| `interrupt` / `clear` / `reset` | Stop mid-line and drop the queue / drop the queue and let the line finish / back to nothing. |

## What `ctl` adds on top

`yarn ctl` is a thin client for the table above, so `yarn ctl camera bust` is a `camera` command and nothing else. Eight of its verbs are not commands, though — they read the API, or they do something in the terminal that no renderer needs to hear about:

| `yarn ctl …` | What it is |
|---|---|
| `vocab` | `GET /api/vocabulary` — what this avatar can be asked for. The object to paste into a system prompt |
| `state` | `GET /api/state` — the snapshot, printed. Says so when no renderer is attached |
| `watch` | The event tail, followed until Ctrl-C. How to see the order turns actually happen in |
| `decks` | The documents on disk, with their page counts. See [Slides](slides.md) |
| `motions` | The gestures in `show/motions/`, with any file that would not parse and why. See [Motions](motions.md) |
| `play` | Run a script. `--check` validates it with no server running. See [Scripts](scripts.md) |
| `hold` / `resume` | The two halves of the `pause` command, spelled apart. See [Recording](recording.md) |

`yarn ctl` with no arguments prints the whole list with worked examples, which is the fastest reference there is.

## Typed cues in a line

The `text` field accepts these inline forms. `[performanceId]` remains shorthand for `[@perform performanceId]`.

| Syntax | Action |
|---|---|
| `[@perform id]` / `[@expression id]` / `[@gesture id]` / `[@hop id]` | Change the named performance, expression, gesture, or hop. |
| `[@camera face\|bust\|upper\|full]` | Change the camera framing at that point. |
| `[@slide 3]` | Move to an absolute, 1-based page. |
| `[@bgm play]` | Resume the selected BGM track immediately from paused, or fade it in from stopped. |
| `[@bgm play track filename]` | Select and play the filename remainder; spaces and Japanese characters are allowed. |
| `[@bgm pause]` / `[@bgm stop]` | Pause or stop the selected track. |

Typed cues travel through ordinary `say`, `queue`, and script text. For `perform`, `expression`, `gesture`, and `hop`, the whole remainder is the id, so spaces and Japanese characters are allowed. Both square brackets are reserved and are not spoken. `room`, `backdrop`, `deck`, and `place` remain line-start `stage` setup. BGM volume, looping, fade durations and DSP are mixer settings in the panel or through the `bgm` command. Relative slides are not inline cues.

## Which hand

A one-handed gesture picks an arm afresh every time it plays. The table authors one pose and mirrors it onto whichever hand is free — every entry was checked on both — and the draw is there because a character who waves with the same arm every time reads as a mechanism rather than a person.

`side`, `L` or `R`, pins it for a caller that has a reason to: the hand away from the document, or the same hand the line before used.

```
yarn ctl gesture peace --side L
yarn ctl perform nice --side R
yarn ctl say "こっちだよ" --gesture pointUp --side L
```

It is one field per line rather than one per field, because a turn plays one movement — `gesture`'s, or the one `perform` names — and a hand written twice could only ever disagree with itself. On a two-handed gesture there is no hand to choose and it fixes which way the head turns instead. A [motion loaded from a file](motions.md) states `L` or `R` itself and ignores it.

Inline cues do not carry it. `[@gesture peace]` mid-sentence draws its hand as before; a line that needs a particular one names the movement on the line rather than inside it.

## What is deliberately absent

There is no command that names a model, a provider or a prompt, and there will not be one. What to say is decided on the other side of the boundary; this table is only about how it is said.

`voice` and `tune` are absent from the MCP surface for a different reason: how a voice is mixed and where the set-once layer sits are decided by ear and by eye against a render, not by a caller that can neither hear nor see the result.

## Next

- [The control API](control-api.md) — endpoints, batching, state
- [Recording](recording.md) — `record` and `pause` as one movement
- [Background music](bgm.md) — files, transport, level and effects
- [Performances](performances.md) — `perform` in detail
- [Lines and cues](lines-and-cues.md) — `say` in detail
