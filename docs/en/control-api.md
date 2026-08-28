# The control API

An orchestrator — a script, an app, or in production an LLM loop — posts commands and reads state:

```
POST /api/command   →   the server   →   SSE   →   the renderer
GET  /api/state     ←                ←   POST  ←
```

The unit of work is a **turn**: one line of dialogue delivered with a face and a gesture, followed by the next one. `POST /api/command?wait=1` blocks until the turn ends, so a caller with nothing to do until the character stops talking does not have to poll.

## Send a whole answer at once

`camera`, `room`, `backdrop` and `deck` take effect when they arrive, which is right for reacting to something and wrong for describing a line that has not been reached. So `say` carries the same axes under `stage`, applied when its turn starts:

```sh
yarn ctl say "This one is the hall." --camera full --room hall
```

That exists for the silence. A caller that sends one line and waits for it before sending the next pays the whole of the next line's synthesis as a gap, because the renderer asks for a line's audio the moment it is queued and a queue one deep leaves nothing to prepare during.

![Three lines, sent one at a time and sent as one batch](../images/turn.svg)

Measured here: 1.2 s between every pair of lines when they travel separately, 0.3 s when they travel together. Staging on the line is what lets a run of lines with four different shots be one request.

So: put the whole of an answer in one `batch`, and let the shots ride on the lines. Only the first line of each answer pays for being made.

An axis left out of `stage` keeps what it had; `null` empties it — dry for a room, the flat background for a backdrop. On the command line an omitted flag is the first and `--room ''` is the second.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /api/command` | One command, or several under `batch` to be delivered together. `?wait=1` returns when the last queued turn ends. |
| `GET /api/state` | Connection, the current state, and the event tail since `?since=`. |
| `GET /api/events` | The event tail alone. `?wait=1` long-polls it. |
| `GET /api/vocabulary` | What the loaded avatar can be asked for. |
| `GET /api/decks` | The documents on disk, with their page counts. Re-read rather than cached: a file appears while the stream is running. |
| `GET /api/decks/<id>/text` | What a document says, page by page, `?from=` and `?to=`. Extracted without drawing anything. |
| `GET /slides/<id>.pdf` | The bytes, for the renderer. Not under `/api/` because it is file serving rather than an API call. |
| `GET /api/motions` | The gestures written into `show/motions/`, parsed and checked, with any file that would not parse listed beside them. Read by the renderer when it connects. |
| `GET /api/stream` | The viewer's SSE down-channel. |
| `POST /api/report` | The viewer's up-channel, and its heartbeat. Not for callers. |
| `POST /api/speech` | The viewer's route to the speech sidecar. Not for callers. 503 when there is no sidecar, which is a normal answer. |

A command the renderer does not understand is dropped rather than failing the request, and unknown fields are stripped: the orchestrator and the renderer are separate processes with separate release cycles, and a newer caller talking to an older renderer should degrade rather than break the stream.

## What comes back

`GET /api/vocabulary` returns what the loaded avatar can be asked for. It is discovered rather than declared — the expression list comes from the model's own shape groups and the wardrobe from its meshes — so it changes when the avatar does. That object is the one to paste into a system prompt, and the cue syntax is stated in it for that reason: a syntax the caller is never told about is a syntax nobody uses.

`GET /api/state` is everything worth branching on, cheap enough to poll: `speaking`, the turn id, the queue depth, the emotion vector, the drawn expression and the raised effects, the performance and gesture that are up, and `strain` — what the last fingertip solve cost each arm.

Pointing is deliberately **not** bounded to the range the vocabulary advertises. Those bounds are anatomical, and reaching past them is a supported outcome rather than an error: the arm goes as far as it can, which is what a person does, and the strain figure is the only way a caller can tell an aim that was met from one the arm could only approximate.

Beside the state it carries three things the renderer reports about *itself* rather than about the performance:

- `voice` — the chain and the loudness of the last take.
- `tuning` — what the set-once layer is actually running, so a remote fader can be drawn at the value in force rather than at the last one somebody sent.
- `avatars` — which characters this renderer can load. Not the same question as what the loaded one can do.

## Next

- [Commands](commands.md) — the full table
- [Performances](performances.md) — what a turn is usually delivered with
- [The MCP adapter](mcp.md) — the same API, as tools
