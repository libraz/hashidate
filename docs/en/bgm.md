# Background music

Background music is a local show asset, played alongside the synthesized voice. Put an MP3 or FLAC file directly in `show/bgm/`; no import or manifest is needed, and the files are not tracked by git.

The control server re-reads the directory whenever the panel, CLI or MCP asks for the list. Filenames are the track ids, including their extension. Subdirectories and symbolic links are not followed. `--bgm <dir>` moves the library when the files belong elsewhere.

The native shell has **Window → Open BGM Folder** for the default library.

```sh
yarn ctl bgm list
yarn ctl bgm play opening.mp3 --volume 0.2 --loop on
yarn ctl bgm pause
yarn ctl bgm resume
yarn ctl bgm stop
```

The default level is 0.2 and looping is on. `stop` returns to the start but keeps the selection; choosing Play again restarts it. The panel also has an Unload action that clears the selected track.

## Panel and MCP

The BGM tab lists the library and controls selection, play, pause, stop, level and looping. Its **Effects — BGM only** section has tone, compression, stereo width and reverb controls. Changes are live and do not alter the synthesized voice or the `room` selected for it.

MCP exposes the same operations as the eighth tool, `bgm`:

| Action | Input |
|---|---|
| `list` | None. Re-scan and return the exact MP3/FLAC ids. |
| `play` | `track`, with optional `volume`, `loop` and `dsp`. |
| `pause` / `resume` / `stop` | No other fields. |
| `settings` | One or more of `volume`, `loop` and `dsp`. |

For example:

```json
{
  "action": "settings",
  "volume": 0.16,
  "dsp": {
    "compression": 0.25,
    "reverb": { "mix": 0.08, "decay": 0.45 }
  }
}
```

`status` returns the selected track, transport, position, duration, level, loop setting and resolved DSP values. A caller should use the id returned by `list`, not construct a `/bgm/` URL itself.

## Inline BGM cues

BGM transport can also be placed inside a spoken line, where it runs on the line's mouth clock:

```text
The opening starts here. [@bgm play opening.mp3]
The next line pauses it. [@bgm pause]
This line resumes the selected track. [@bgm play]
The segment ends here. [@bgm stop]
```

The track name is optional for `play`; without it, the selected track resumes. The remainder after `play` is the exact filename, so spaces and Japanese characters are allowed. The `[` and `]` characters are reserved. These cues work through ordinary `speak`, `say`, `queue`, and script text, and need no separate MCP or CLI operation. Use the panel or the `bgm` MCP tool for volume, looping, and DSP; those settings are not line cues.

## BGM-only effects

The fixed chain is provided by libsonare: tone tilt, compressor, stereo imager and plate reverb, in that order. The public controls are deliberately smaller than the plug-ins' full parameter sets:

| Control | Range | Neutral/default |
|---|---:|---:|
| Tone | −6 to +6 dB | 0 dB |
| Compression | 0 to 1 | 0 |
| Stereo width | 0 to 2 | 1 |
| Reverb mix | 0 to 0.5 | 0 |
| Reverb decay | 0 to 0.9 | 0.5 |
| Reverb damping | 0 to 1 | 0.5 |

If the worklet cannot start, the track continues through a dry path instead of going silent. The panel warns about that fallback, and MCP reports `dspDegraded: true` in status.

## Several renderers and recording

The server owns the transport clock. A stage, the panel preview and an OBS browser source therefore join the same track at the same point rather than each starting a private copy from zero. A late renderer receives the current selection, position and settings when it connects.

Whether one of those pages makes sound is still decided only by its URL. `?mute=1` mutes voice and BGM together; there is no separate renderer-mute command. The panel preview is therefore silent even though it follows the transport.

Voice and processed BGM meet at the viewer's shared output. A recording made by the unmuted renderer contains both, at the same levels heard from that page.

## Next

- [The MCP adapter](mcp.md) — the tool alongside the other seven
- [The control API](control-api.md) — the HTTP routes and state
- [Recording](recording.md) — which renderer writes the shared mix
