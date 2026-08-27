# Architecture

![hashidate architecture](../images/architecture.svg)

Three processes and a page. A caller posts commands to the control server; the server streams them to the renderer over SSE and the renderer reports back. OBS points at the renderer's page. Everything binds to `127.0.0.1`.

## Repository layout

| Path | What it holds |
|---|---|
| `src/engine` | The runtime. Profile, rig, anatomy, motion, face, secondary motion, director, session. Depends on three.js and on nothing in a browser. |
| `src/avatars` | One descriptor per model. Adding an avatar is adding a file. |
| `src/protocol` | The wire format, as zod schemas. The viewer, the server and the CLI all import it, so the command vocabulary cannot drift between them. |
| `src/viewer` | The renderer: a three.js stage, with a development console beside it. This is the page OBS points at. |
| `src/panel` | The broadcast panel, on `/panel/`. Everything it does goes through the control API, so what it can do is what an orchestrator can do. |
| `src/server` | The local control API. Serves both pages and carries commands to the renderer. |
| `src/control` | The node-side client for that API, shared by `ctl` and the MCP adapter. |
| `src/cli` | `ctl` — a thin client, for driving the avatar by hand. |
| `src/mcp` | The MCP adapter: the same control API, as tools a language model can be handed. |
| `tools/blender` | The model pipeline. Python, because it runs inside Blender. |
| `tools/tts` | The speech sidecar. Python, because the speech model is a PyTorch codebase. Reached over HTTP, never imported. |
| `slides/` | The documents she presents from. Not tracked, not part of the build, and `--slides` moves it elsewhere entirely. |

## The seams that matter

**The wire vocabulary lives once**, in `src/protocol`, as zod schemas. Adding a command means adding it there first; the viewer, the server and the CLI follow. That is what keeps three processes on separate release cycles from drifting apart.

**The engine does not know it is in a browser.** It depends on three.js and on nothing else — no `AudioContext`, no DOM, no `fetch`. It states what a spoken line is; the viewer, which has the audio, provides one. That is why the test suite can run the whole engine headlessly against a synthetic avatar.

**The server holds the standing state.** The avatar, the costume, the shot, the set, the acoustic, the voice chain and the tuning are folded into a setup as they are chosen, and handed to a renderer the moment it attaches — along with the pending queue. Nothing about the show lives in the URL a browser source was configured with, and a reload mid-broadcast is survivable. See [Two surfaces](surfaces.md).

**The MCP adapter holds no judgement.** Every tool is one of the HTTP endpoints, with the loaded avatar's own ids compiled into the schemas. It is a translation, not a second control plane. See [The MCP adapter](mcp.md).

**The speech sidecar is proxied, not called.** The viewer reaches it through `POST /api/speech` rather than directly, for the same reason everything here is loopback: the sidecar sends no CORS header, so a page served from this origin cannot reach that one. The two ways to make a direct call work would be to add a CORS header to the voice or to move it off loopback, and both are licensing decisions.

## Next

- [The control API](control-api.md)
- [Avatars](avatars.md)
- [Two surfaces](surfaces.md)
