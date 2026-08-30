# The MCP adapter

`yarn mcp` is the same control API as an MCP server, over stdio. The client starts the process, so there is nothing to leave running and no second listening socket to account for. `--base` names a control server other than the default.

```json
{
  "mcpServers": {
    "hashidate": { "command": "yarn", "args": ["mcp"], "cwd": "/path/to/hashidate" }
  }
}
```

## Eight tools

| Tool | What it does |
|---|---|
| `speak` | Queue lines. A run of them travels in one call, and each `text` can carry inline performance, shot, slide, or BGM cues. |
| `status` | What to branch on: speaking, queue depth, the face and movement that are up, strain. |
| `interrupt` | Stop mid-line and drop the queue. |
| `react` | The immediate half of everything else — a performance, a gesture, a glance. |
| `stage` | The persistent half — the camera, the set, the acoustic, the document. |
| `revise` | Edit what is already queued. |
| `deck` | Read a document, so a script can be written about it. |
| `bgm` | List and play local MP3/FLAC tracks; set their level, loop, crossfade durations and BGM-only libsonare effects. |

The vocabulary is a resource — `hashidate://vocabulary` — and so is what has already been said.

## It is an adapter, not a second control plane

Every tool is one of the endpoints in [The control API](control-api.md), and it holds no judgement of its own. What it adds is three things, and it would not be worth having for fewer.

- **The ids are in the tool schemas.** `perform`, `expression`, `gesture`, `backdrop` and `room` are narrowed to the ids the loaded avatar actually has, rebuilt and announced as a list change when the avatar is swapped. A model reading a schema does not invent an id the way one reading a prompt does.
- **A refused call is answered.** The API drops a command it cannot parse, which is right between two processes on separate release cycles and wrong when the caller is a model — it carries on as though the line had been said. So the adapter parses first, sends nothing, and hands the complaint back with the list it should have been picking from.
- **A run of lines travels in one call**, for the reason in [Send a whole answer at once](control-api.md#send-a-whole-answer-at-once).

## Where the lines go

Lines go on the server's queue rather than out as a `say`, so they survive a viewer reload, they appear in the panel where they can be reordered and rewritten, and they carry `source: mcp` to tell them from a comment or from something typed by hand.

## Cue notation in `speak`

The `text` field accepts the legacy `[performanceId]` shorthand and these typed forms:

```text
[@perform id] [@expression id] [@gesture id] [@hop id]
[@camera face|bust|upper|full] [@slide 3]
[@bgm play] [@bgm play track filename] [@bgm pause] [@bgm stop]
```

`[@bgm play]` resumes the selected track. The remainder after `play` is the exact BGM filename, so spaces and Japanese characters are allowed. The same remainder rule applies to dynamic performance, expression, gesture, and hop ids. `[` and `]` are reserved. Typed cues are ordinary line text and travel through `speak` and script queues. `room`, `backdrop`, `deck`, and `place` stay in line-start `stage` setup. BGM play cues inherit the current fade settings. BGM volume, looping, fade durations and DSP stay in the panel or the `bgm` tool's settings action. Relative slides are not inline cues. See [Lines and cues](lines-and-cues.md) for the timing rules.

## Background music

`bgm` with `action: "list"` re-scans `show/bgm/` and returns the exact filenames a later `play` accepts. The remaining actions are `play`, `pause`, `resume`, `stop` and `settings`. Level, looping and `fade` can be changed independently; `fade.inSeconds` and `fade.outSeconds` are 0..10 seconds, where 0 is a hard edge. A different-track play crossfades the two tracks; the first/stopped play uses only fade-in, and pause/resume/stop are immediate. The `dsp` object controls tone, compression, stereo width and reverb on BGM alone. See [Background music](bgm.md).

`status` includes the server-owned BGM transport and resolved settings, so a caller can tell whether it is playing and whether a renderer had to fall back to dry playback.

## What is deliberately absent

`voice` and `tune` are not exposed. How a voice is mixed and where the set-once layer sits are decided by ear and by eye against a render, not by a caller that can neither hear nor see the result.

Neither is anything about the model driving it. The adapter does not know which model is on the other end of the stdio pipe, and nothing in it changes if that answer changes.

## Next

- [The control API](control-api.md) — the endpoints these tools wrap
- [Use cases](use-cases.md) — what to point a model at
