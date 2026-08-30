# The native shell

```sh
yarn shell
```

Builds the pages, starts the control server and — if this checkout has one — the speech sidecar, and opens the panel and the stage as two native windows. Quitting stops everything it started.

![What `yarn shell` starts](../images/shell.svg)

It is a convenience rather than a fourth surface. Everything inside it is the same three pages on the same loopback addresses, and everything it can do to the show it does through the same control API. What it adds is the handful of things a browser tab cannot do, each of them a question about the desk rather than about the broadcast.

| What it adds | Why a browser cannot |
|---|---|
| The windows come back where they were left | A tab does not remember which screen it was dragged onto, or where |
| The stage starts its audio unasked | Autoplay needs a click, and there is no page for an operator to give one to |
| `Window → Mute Stage` | Whether *this machine* makes a sound is not a property of the show |
| One quit stops three processes | A closed terminal leaves the server and the sidecar holding their addresses |
| The show directories open in the file manager | A page cannot name a path on the machine serving it |
| A script can be picked from a file dialog | The panel can list `show/scripts/`, but it cannot read a file from anywhere else |

## What it starts

Three processes, in this order.

1. **The control server**, on `127.0.0.1:8765`, started with this checkout's `dist/` and `show/` directories on its command line.
2. **The speech sidecar**, only when `tools/tts/.venv/bin/python` exists and nothing is already answering on the socket. It is started and never waited on, because loading the model takes the better part of a minute and the viewer and the control API work without a voice.
3. **The two windows**, on `/panel/` and `/monitor/`.

A control server **already running on this checkout is used rather than replaced**, so a `yarn dev` left up in a terminal is not taken down, and it is not stopped on quit either: the shell only stops a child it started itself.

A server running on a *different* checkout is refused by name rather than adopted:

```
:8765 is held by a control server for /Users/…/other/dist, but this checkout
serves /Users/…/hashidate/dist. Stop it, or start this one on another port
with HASHIDATE_CONTROL_PORT.
```

That check exists because two checkouts answer `/api/state` identically, so adopting the wrong one would give an operator two windows loaded from another build and a menu that opens *this* checkout's show directories while driving another, with no error anywhere. The failure would present as a renderer that will not come up.

A second `yarn shell` does not start a second application. It raises the windows of the one already running, stage first and panel last, so the panel is the one with focus.

## The menu

| Menu | Item | What it does |
|---|---|---|
| File | Run Script… (`⌘⇧O` / `Ctrl+Shift+O`) | Pick a `.yaml`, `.yml` or `.json` script from anywhere on disk and queue it, the same way `yarn ctl play` does |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All | Present because macOS wires up those shortcuts only for a window whose menu carries the roles, and the panel is a page lines get written into |
| Window | hashidate — Control | Raise the panel, or reopen it if it was closed |
| Window | hashidate — Stage | Raise the stage, or reopen it |
| Window | Mute Stage | Whether the stage window opens silent. Remembered between runs |
| Window | Open Slides / Scripts / Motions / BGM / Recordings Folder | Open a show directory in the file manager |
| Window | Three status lines | Read-only. See below |

The three status lines at the foot of the Window menu are refreshed every two seconds from `GET /api/state`:

| Line | Values |
|---|---|
| `● Control` | `starting`, `online`, `offline` |
| `● Speech` | `ready`, `loading`, `absent`, `down`, `unknown` |
| `● Renderers` | `connected (n)`, `disconnected` |

The interval is slower than the panel's own polling on purpose: this is three lines behind a menu opened once something already seems wrong, rather than a surface read during a broadcast. `Renderers` counts every attached renderer, which is at least the stage window. It is not a claim that OBS is live, because OBS has no distinct identity on the control protocol.

`Speech: absent` means no sidecar was found, which is the ordinary state of a checkout that has not run `make voice`. `down` means one answered earlier and has stopped, which is the state worth acting on: the queue still drains and the mouth still moves, so a voice that died mid-broadcast is otherwise invisible. See [Speech](speech.md).

## Mute Stage

The stage window is the one renderer in this application that makes a sound, and whether it should is a property of the desk:

- With OBS **monitoring** its browser source, the room already hears the character, and this window makes it every line twice a fraction of a second apart. Mute it.
- With monitoring **off**, this window is the only way to hear anything at all. Leave it audible.

No orchestrator and no line of script can answer that, so it is a switch, and it is remembered between runs.

It costs a reload: the mute is on the URL — `/monitor/?mute=1` — rather than sent to a page that is already up, so the model loads again and the picture is black for a second or two. That trade suits this setting and would not suit the panel's preview, because this is decided once while the desk is being set up rather than reached for during a broadcast. See [The renderer's URL](surfaces.md#the-renderers-url).

## State and logs

| What | Where | Notes |
|---|---|---|
| Window placement and the stage mute | `shell-state.json`, beside the Electron profile | macOS: `~/Library/Application Support/hashidate/`. A rectangle that no longer lands on any current display is discarded rather than restored |
| The control server's output | `control.log`, in Electron's log directory | macOS: `~/Library/Logs/hashidate/`. Appended, so a crash loop keeps its whole history |
| The sidecar's output | `speech.log`, beside it | Where a model that failed to load reports it |

Those two log files are where to look for "there is no sound" and "the renderer never came up".

## Window restrictions

The shell is a browser with the address bar taken away, so the things a browser would ordinarily let a page reach are closed rather than left at their defaults.

- **Two URLs, exactly.** A top-level window may load `http://127.0.0.1:<port>/panel/` or `http://127.0.0.1:<port>/monitor/` and nothing else — not `/`, not `/api/`, not `localhost`, not another port. Navigation and redirects to anything else are cancelled. The monitor's own iframe is a child frame and is deliberately left alone, because that viewer URL is part of what the monitor page is.
- **No new windows and no webviews.** `window.open` is denied outright.
- **One permission.** Everything is refused except sanitised clipboard *writes*. That one is necessary because taking the address bar away leaves no other way out: the panel composes a URL for OBS, and a button is the only way to get it out of a window with nothing to select from. Reading the clipboard is refused, as are device permissions.
- **The window keeps the menu's name.** Both pages set a title meant for a browser tab strip, and two of those are hard to tell apart in a window list, so a page changing its own title is ignored.

Four Chromium switches are set before the application becomes ready: three that stop a backgrounded or occluded window being throttled, because a stage behind the panel has to keep rendering, and the autoplay policy that lets the stage make a sound without a click.

## Configuration

`HASHIDATE_CONTROL_PORT` moves the control server and both windows together. It is the one thing about the address that can be changed: there is deliberately no way to set the *host*, here or anywhere else. See [Configuration](getting-started.md#configuration).

## Not packaged

`yarn shell` runs out of a development checkout, and the shell resolves the repository from its own source file. There is no `.app`, no installer and no auto-update. Packaging this would put a purchased avatar inside a distributable, which the licences do not allow. See [Avatars](avatars.md#licensing-is-why-the-runtime-is-loopback-only).

Shipping a build would also change what has to travel with it: the bundled IBM Plex fonts are OFL-1.1, and their licence would have to go in the box.

## Next

- [The surfaces](surfaces.md) — all three pages, two of which this opens as windows
- [Recording](recording.md) — what `Open Recordings Folder` is for
- [Getting started](getting-started.md) — running it without the shell
