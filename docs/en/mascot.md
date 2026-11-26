# The desktop mascot

```sh
yarn mascot
```

Puts the character on the desktop: one transparent window over everything else, full length, with a tray icon to reach it by. It is the same renderer and the same control server as the rest of the runtime, opened a second way, and a program that wants to react to the person at the desk can read the touches the window reports.

Like [the native shell](shell.md) it is a launcher for a development checkout and is not packaged. It loads one exact loopback address and nothing else.

## Running it

| Script | What it does |
|---|---|
| `yarn mascot:build` | Builds the viewer pages and the window's preload script, `dist/mascot/preload.cjs` |
| `yarn mascot` | Builds, then starts the mascot |

It starts the control server and, if this checkout has one, the speech sidecar, exactly as the shell does, and adopts a server that is already answering on this checkout. Quitting from the tray stops what it started. The Dock icon is hidden, so the tray is the whole of its presence.

## The window

- **Transparent and frameless**, always on top, on every Space, and not above a full-screen application.
- **Click-through outside the character.** The page tests the pointer against the avatar's outline plus a margin of 6 px and asks the window to take the mouse only while the pointer is over it. Leaving the outline hands the mouse back after 200 ms. Everywhere else a click reaches what is underneath.
- **Full body.** The page is the viewer's mascot mode, and it opens on the full-length frame.
- **Rendering does not throttle** when the window is behind others.

### Display mode and size

| Mode | Where the window goes |
|---|---|
| Fill the height | The work area's full height, in the bottom-right corner, with no margin |
| Bottom right, bottom left | A corner of the work area, 16 px from the bottom and from the side |
| Free | Where it was dragged to |

In every mode the window is 0.45 times as wide as it is tall. In a corner or free it is `scale` times the work area's height less 16 px. `scale` runs from 0.25 to 2.0 and stops at either end. Above 1.0 the window is taller than the work area: in a corner its top stays at the work area's top and the feet hang below the screen. A free window is left where it was dropped, however much of it hangs outside, and is moved only when its head would leave the work area. The head point is the window's horizontal centre, 8% of its height below its top; it may lie on the work area's edge. The width never exceeds the work area's width less 32 px; a size that would is drawn capped, and the saved `scale` keeps its value. The menus move it in steps of 0.05; the wheel moves it continuously.

- **Dragging.** While the character does not have focus, pressing on it and moving more than 4 px moves the window. The first movement switches the mode to Free, and 300 ms after the last one the position and scale are saved.
- **Size.** While the character has focus, the wheel resizes it continuously: wheel up enlarges, wheel down shrinks, and the turns within a frame are applied together. The tray and the context menu step the size by 0.05. A corner stays put while it grows; a free window keeps its feet where they were, unless its head would then leave the work area.
- **From Fill the height**, a smaller or a larger size goes to bottom right at that size, so a larger one is 16 px further left than the full-height window was.
- **Reset position** goes to bottom right at scale 0.5.
- **Displays.** The window uses the display its head point is on, so a tall window hanging below one display stays with the display of its head. Moving to a display of a different height keeps the feet and changes the size. A saved position whose display is gone is shown in the primary display's bottom-right corner and is not overwritten, so the mascot goes back when the display does.

### Focus and turning

A tap on the character gives it focus, and the pointer shows a grab cursor. Focus ends when the pointer hands the mouse back or leaves the page, when the window loses focus, or when a shrink leaves the character out from under the pointer.

| While the character | Dragging | Wheel |
|---|---|---|
| Has focus | Turns the camera round it, once per frame | Resizes the window; the page leaves it alone otherwise |
| Does not have focus | Moves the window | Does nothing, and is not swallowed |

The angle is the window's own. It travels over the bridge rather than as a `camera` command, because a command is followed by every renderer and would swing the panel's preview and OBS along with the mascot. It is kept in `shell-state.json`, shown again after every page load, and **Face Front** in the context menu returns it to the front. Reset position leaves it alone.

Mode, scale, position, angle and mute are kept in `shell-state.json` beside the Electron profile, in the same place the shell keeps its own state.

### Menus

The tray icon holds show or hide, display mode, size, avatar, mute and quit. The right-click on the character holds display mode, size, outfit, face front, reset position and hide. Hiding leaves the process running and the tray is how it comes back. Mode and size are in both, because the tray is the one that can still be reached when the character is somewhere it cannot be clicked.

## The window's bridge

Whether the window takes the mouse, and moving or resizing it, are decided on the page and carried out by the shell. Going through the control server would be too slow for a pointer crossing an outline, so the preload script exposes `window.hashidateMascot` with five calls and nothing else:

| Call | Effect |
|---|---|
| `setInteractive(on)` | The window takes the mouse, or lets it through |
| `moveBy(dx, dy)` | Moves the window by that many screen pixels |
| `scaleBy(factor)` | Multiplies the size by `factor`, from 0.5 to 2 |
| `turnTo(angle)` | Hands over the yaw and pitch a turn settled on, for the shell to keep |
| `onShot(fn)` | Hears the angle to show: the kept one after each load, the front after Face Front. Returns a function that stops listening |

The main process accepts a call only from the mascot's own page and checks every argument. A resize or a turn is normalised and clamped there, and an argument that is not a finite number is refused. The object is absent on every other page, OBS and the stage included, and a page without it behaves as before. No command, report or file access crosses it.

## The page

The mascot page is `/?mascot=1&transparent=1`, the viewer's `mascot` stage mode with a transparent background. Opened in a browser, the same URL has no bridge: the pointer is left alone and no touch is reported. The mode changes the opening shot to full length and nothing else about the picture. See [The renderer's URL](surfaces.md#the-renderers-url).

The shell's window may load `/panel/` and `/monitor/`; the mascot window may load only this one page, in its two exact forms, `/?mascot=1&transparent=1` and the same with `&mute=1`. Any other path, query, fragment, host or port is cancelled, and so are redirects. Loopback stays the rule: there is no host to set and no CORS header.

## Touches

A touch is reported to the control server as a session event and nothing more. What the character does about it is the caller's to decide from the event tail. Touches are the only events a renderer reports that no `say` caused.

| Event | When |
|---|---|
| `touch.tap` | A press and release in place. A run of taps within 350 ms of each other counts up, one event per tap, to a ceiling of 10 |
| `touch.hold` | A press held for 600 ms, reported once, with `count` 1. Releasing does not add a tap; moving more than 4 px afterwards turns it into a drag |

Both carry optional fields:

| Field | Values |
|---|---|
| `part` | `head`, `torso`, `arm`, `hand`, `leg`. Taken from the bone that weighs most on the face under the pointer; the neck and eyes count as `head`, the clavicle as `arm` |
| `side` | `L` or `R`, for a part that has one. Never present on `head` or `torso` |
| `count` | 1 to 10, the tap's place in its run |

A page sends one with `ControlClient.pushEvent(event)` from `src/viewer/control-client.ts`. It goes up at once, like a turn boundary, and does not wait for the next tick of the reporting timer.

### Readers skip what they do not know

A renderer's report stays strict, so a malformed event is refused. The readers of `GET /api/state` and `GET /api/events` are tolerant: `sessionEventsSchema` drops an element that does not validate, such as an event type or a `part` added after the reader was written, and keeps the rest of the list. The processes on either end have separate release cycles, and a closed list read strictly would make every new event type an exception in every older reader.

Adding an event type or a `part` value therefore does not break a reader that already has this schema. Which readers have it:

- the CLI (`watch`, `inspect`, `show`), the MCP adapter, the panel and the shell's health probe, all from this checkout, once restarted;
- the control client in `src/control`, and anything that imports it.

## After an update

- **A reader started before the update must be restarted.** A long-running MCP server, a script holding an old `ControlClient`, or any other process that read `/api/state` before the touch events existed throws when one arrives, because its list is closed.
- **A control server started before the update must be restarted too.** The mascot adopts a server that is already answering, and that server rejects the whole report of a page that sends a touch, so turn events stop arriving as well as touches. Restart the server and it is fixed.
- Only the mascot emits touches. While it is not running no new type appears on the wire.

## Sharing the profile with the shell

The shell and the mascot are one renderer and one voice opened two ways, and running both would say every line twice. They share a single Electron profile per checkout, with the same Chromium switches and the same single-instance lock, so only one of them owns it.

| Situation | What happens |
|---|---|
| The mascot is running and `yarn shell` is started | The shell cannot take the lock and exits with status 0, as it does for any second launch. The mascot does nothing |
| The shell is running and `yarn mascot` is started | The mascot cannot take the lock and exits with status 75 before opening anything. The shell raises its windows, as for any second launch |
| A second `yarn mascot` | Exits with status 75 |

Status 75 is `EX_TEMPFAIL`. A program that starts the mascot can tell "one is already up" from a crash and not start it again. Quitting from the tray exits with 0, which says the person closed it. A mascot that fails to start exits with 1.

## Muting

The tray's mute reopens the window on `/?mascot=1&transparent=1&mute=1` and saves the choice. Whether a renderer makes a sound is decided by its URL and nothing else, so there is no call that silences a page whose address stays the same.

A muted mascot still asks for every line and plays it into a gain of zero, so it behaves like a speaking one from every angle the API can see. `GET /api/state` does not say which renderers are muted. A caller cannot tell a muted mascot from a silent one, and a program that needs to know has to be the one that opened it.

## Next

- [The native shell](shell.md): the other native window, and the lock they share
- [The control API](control-api.md): where the touch events are read
- [The surfaces](surfaces.md): the renderer's URL and its modes
