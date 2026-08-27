# The MCP adapter

`yarn mcp` is the same control API as an MCP server, over stdio. The client starts the process, so there is nothing to leave running and no second listening socket to account for. `--base` names a control server other than the default.

```json
{
  "mcpServers": {
    "hashidate": { "command": "yarn", "args": ["mcp"], "cwd": "/path/to/hashidate" }
  }
}
```

## Seven tools

| Tool | What it does |
|---|---|
| `speak` | Queue lines. A run of them travels in one call. |
| `status` | What to branch on: speaking, queue depth, the face and movement that are up, strain. |
| `interrupt` | Stop mid-line and drop the queue. |
| `react` | The immediate half of everything else — a performance, a gesture, a glance. |
| `stage` | The persistent half — the camera, the set, the acoustic, the document. |
| `revise` | Edit what is already queued. |
| `deck` | Read a document, so a script can be written about it. |

The vocabulary is a resource — `hashidate://vocabulary` — and so is what has already been said.

## It is an adapter, not a second control plane

Every tool is one of the endpoints in [The control API](control-api.md), and it holds no judgement of its own. What it adds is three things, and it would not be worth having for fewer.

- **The ids are in the tool schemas.** `perform`, `expression`, `gesture`, `backdrop` and `room` are narrowed to the ids the loaded avatar actually has, rebuilt and announced as a list change when the avatar is swapped. A model reading a schema does not invent an id the way one reading a prompt does.
- **A refused call is answered.** The API drops a command it cannot parse, which is right between two processes on separate release cycles and wrong when the caller is a model — it carries on as though the line had been said. So the adapter parses first, sends nothing, and hands the complaint back with the list it should have been picking from.
- **A run of lines travels in one call**, for the reason in [Send a whole answer at once](control-api.md#send-a-whole-answer-at-once).

## Where the lines go

Lines go on the server's queue rather than out as a `say`, so they survive a viewer reload, they appear in the panel where they can be reordered and rewritten, and they carry `source: mcp` to tell them from a comment or from something typed by hand.

## What is deliberately absent

`voice` and `tune` are not exposed. How a voice is mixed and where the set-once layer sits are decided by ear and by eye against a render, not by a caller that can neither hear nor see the result.

Neither is anything about the model driving it. The adapter does not know which model is on the other end of the stdio pipe, and nothing in it changes if that answer changes.

## Next

- [The control API](control-api.md) — the endpoints these tools wrap
- [Use cases](use-cases.md) — what to point a model at
