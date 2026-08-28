# Commands

Every command goes to `POST /api/command`, one at a time or several under `batch`. `yarn ctl <command>` is the same thing from a terminal.

| Command | What it does |
|---|---|
| `perform` | A named face and movement. No id releases the one that is up. |
| `say` | Queue a turn. Takes a `perform`, or the parts spelled out, or performances written into the text itself. `hold` keeps the face up past the line. `reading` gives the kana pronunciation where the writing does not determine it, and carries no cues of its own. `stage` names the shot. |
| `emotion` | The persistent mood, as a blend rather than a choice. |
| `expression` | One of the avatar's own drawn faces. `null` hands the face back to the emotion. |
| `overlay` | A drawn effect, at a weight. It layers over whatever face is showing, so several can be up at once. |
| `gesture` | One movement from the gesture table. No id stops it. |
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
| `interrupt` / `clear` / `reset` | Stop mid-line and drop the queue / drop the queue and let the line finish / back to nothing. |

## What is deliberately absent

There is no command that names a model, a provider or a prompt, and there will not be one. What to say is decided on the other side of the boundary; this table is only about how it is said.

`voice` and `tune` are absent from the MCP surface for a different reason: how a voice is mixed and where the set-once layer sits are decided by ear and by eye against a render, not by a caller that can neither hear nor see the result.

## Next

- [The control API](control-api.md) — endpoints, batching, state
- [Performances](performances.md) — `perform` in detail
- [Lines and cues](lines-and-cues.md) — `say` in detail
