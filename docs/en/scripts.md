# Scripts

A run of turns, written out in advance and kept in a file.

Nothing here decides what to say. A script is somebody having already decided — a demo, a rehearsal, the opening segment that is the same every week — so it sits on the same side of the line as an orchestrator's output rather than on this side of it. What the runtime supplies is a way to *write turns down*, and the reason it is worth supplying is that the alternative was a shell script full of `yarn ctl say`, which cannot express the shot a line is delivered in and reorders itself the moment anybody edits it.

Scripts live in `show/scripts/`. Only `demo.yaml` is tracked; anything else you put there is yours.

```sh
yarn ctl play demo --check     # read and validate it, with no server running
yarn ctl play demo            # setup, then its lines onto the queue
yarn ctl play demo --replace  # drop what is pending first
yarn ctl play demo --hold     # load it without starting it
yarn ctl play show/scripts/opening.yaml
```

The panel has the same list, at the top of its Queue tab — above the queue a script fills, so the lines appear underneath the moment one is pressed. There it holds by default, and the toggle beside the list is what decides that; see [Recording](recording.md).

A name is looked for in `show/scripts/`, under `.yaml`, `.yml` and `.json` in that order when it carries no extension of its own. Anything with a separator in it, or an absolute path, is read exactly where it says — so a script in the working directory is `./opening.yaml`, spelled out.

## What a script is

```yaml
title: The opening
note: |
  Notes for whoever opens this file. Never sent, never spoken.

setup:
  - cmd: reset
  - cmd: idle
    on: true
  - cmd: bgm
    action: play
    track: opening.mp3
  - cmd: place
    avatar: { anchor: bottom-right, width: 0.32 }

lines:
  - text: "[hello]Good evening."
    stage:
      camera: bust
      backdrop: dusk

  - text: "[explain]Here is what we are looking at today."
    stage:
      deck: intro
      slide: 1
```

Two halves, because they have two lifetimes. `setup` is applied once, before anything is said: which avatar, what it is wearing, where the picture sits in the frame. `lines` are the turns, and each carries the shot it is delivered in.

That split is the one the command set already makes between what outlives a turn and what is released with it — see [Commands](commands.md).

## Cues in lines

The `text` field can contain the legacy `[performanceId]` shorthand and typed cues such as `[@camera bust]`, `[@slide 2]`, and `[@bgm play opening.mp3]`. A cue fires at that point in the spoken line, so it can change the shot or BGM without adding a gap. `[@bgm play]` resumes the selected track; a track name may contain spaces and Japanese characters. Square brackets are reserved and are not spoken. The full syntax is in [Lines and cues](lines-and-cues.md).

Inline cues use the same text that `speak`, `say`, and `queue` accept. They are not a second script dialect. Line-start `stage` remains the place for `room`, `backdrop`, `deck`, and `place`, while BGM volume, looping, and DSP stay in the `bgm` command or its panel/MCP controls.

## It invents no vocabulary

A line **is** a turn: the payload of `say`, field for field, schema included. A `setup` entry **is** a command, spelled exactly as it goes on the wire.

The cost is that `setup` reads as a list of `cmd:` objects rather than as prose, and that is the right trade. A script format with its own words for a camera framing would be a second dialect for three processes on separate release cycles to drift across, which is the failure `src/protocol` exists to prevent. As written, the file says what will actually be sent.

Four verbs may not appear in `setup` — `say`, `queue`, `interrupt` and `clear`. All four are about the run rather than about the state it assumes, and each would race the queue the script is about to fill.

## The lines go on the queue

Not out as `say` commands, and that is the reason `play` is worth having over a loop in a shell.

The queue lives in the control server. It survives a viewer reload, it is editable from the panel while it plays, and it is deep enough for the renderer to prepare the next line's audio during the current one — a caller sending a line at a time and waiting for each pays about 1.2 s of silence between every pair of them. Handing the whole run over at once takes that to 0.3 s, and it only works because the staging travels on the lines.

Every entry is stamped with the script's own name, so a queue holding a scripted segment, a comment somebody answered and a line typed by hand stays legible. See [The surfaces](surfaces.md).

## Holding a run

`--hold` loads the lines without starting them, and `yarn ctl resume` lets them go. The line being spoken when a hold arrives finishes normally; nothing is discarded.

A held queue is still being prepared. A line's audio is made when it *enters* the queue rather than when it is played, so the whole script is being synthesised while the hold is on — and the first line comes out the moment the hold comes off, rather than after the second or so it would have taken to make it.

That is what a recorded segment needs, and the panel builds the whole sequence out of it. It is also useful on its own: a script queued a minute before a segment starts is a script whose first line does not open with a wait.

## `--check` is the loop

It reads the file, validates every line against the same schema the wire uses, and prints what would be sent. It needs no server and no renderer, which makes it the thing to run between edits.

A script is run against a live stream. Validating at the moment each line is sent would mean a run that stops on line nine has already put eight lines on air.

```
$ yarn ctl play demo --check
hashidate はこういうものです  —  /…/show/scripts/demo.yaml
setup   reset, idle, look
lines   22
  1  [hello]こんばんは。今日は、わたしが動いている仕組みそのものの話をします。
      stage camera=bust backdrop=dusk room=room
  …
```

## The demo

`show/scripts/demo.yaml` is the runtime introducing itself, in about two minutes. It is also a worked example: every feature it talks about it also uses, so the cue markup is demonstrated mid-sentence, the shot changes on the line that mentions shots, and the acoustic changes on the line that mentions acoustics.

It names no avatar, no drawn expression and no overlay. Those are one model's data and a fresh checkout has no model in it — a demo that used them would be a demo that runs on one machine.

The deck it presents from, `show/slides/hashidate.pdf`, does ship: it is five pages about this runtime and it is ours to publish. Its source is a separate deck repository rather than this one, so rebuilding it is not a step a checkout needs — the built file is what belongs here.

## Next

- [Recording](recording.md) — loading a script to write a take from it
- [Lines and cues](lines-and-cues.md) — what goes inside a line
- [Commands](commands.md) — what can go in `setup`
- [The surfaces](surfaces.md) — the queue a script lands in
