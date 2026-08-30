# Recording

A video file of the composed frame, written by the control server while the character speaks.

OBS is the right answer for a broadcast, and it stays the right answer. This is for the other thing: a segment recorded once, off a script, with slides behind it — where launching a compositor, pointing a browser source at a URL and remembering to press the right button is more apparatus than the job deserves.

## The order it happens in

1. **Load a script.** The Queue tab lists what is in `show/scripts/`, above the queue it fills. Pressing one replaces the queue and loads it — and it does not start. The lines appear underneath, which is how you know it worked.
2. **Frame the shot.** The character is standing there with the whole run of lines loaded. Drag the preview, set where the document sits, pick the room.
3. **Press Record**, on the Recording tab. The take starts, and the queue is let go the moment bytes are actually being written.
4. **It stops itself** a moment after the last line, and the file is in `show/recordings/`.

Step 1 is the part that makes the rest work. A script that started on arrival would mean framing the shot during the first two lines, or loading it blind and hoping.

**Load without starting**, beside the picker, is what holds it. On by default, because that is what a take needs. Turned off, the picker is what it reads like: press a script and it plays — the same thing `yarn ctl play` does from a prompt, and what an operator running a segment live wants.

The hold itself is on the on-air readout, as **Start** and **Hold**. That is where it belongs: a held queue with twenty lines in it and an idle one with none are different answers to "is anything happening", and that readout is the question.

## Held is not paused-and-stalled

A held queue is still being prepared. A line's audio is made when it enters the queue rather than when it is played, so while the shot is being framed the speech sidecar is working through the whole script. Letting the hold go starts the first line immediately, rather than after the second or so it would take to synthesise it.

That is also why the hold is released by *evidence* rather than by a timer. The panel does not send "start recording" and then "go" a beat later; the server sends the record command, waits for the first chunk of encoded video to come back, and only then releases the queue. A guess about how long an encoder takes to produce its first frames would be short sometimes, and short by anything at all clips the front of the line the take opens on.

The hold is a command like any other, so it also stands alone:

```sh
yarn ctl play opening --hold   # queue it without starting it
yarn ctl resume                # let it go
yarn ctl hold                  # stop it again
```

`hold` and `resume` are the two halves of the one wire command, `pause` — the CLI spells them apart because a flag with two states is one more thing to get the wrong way round at the top of a take. See [Commands](commands.md).

The line being spoken when a hold arrives finishes normally. Nothing is discarded — cutting a line off is `interrupt`, and dropping the rest is `clear`.

## The output is not the window

The frame is composed a second time, into a canvas of the size the take was started at. A recording is 1920×1080 whether the stage window is fullscreen or a strip down one side of a desk.

It has to be composed again because what is on screen is not one canvas: the document layer is DOM canvases the browser composites *behind* the WebGL canvas, with CSS behind both. Capturing either canvas alone would produce a recording missing half the picture.

What that cannot do is add detail. A stage window drawn at 800 pixels wide, scaled up to a 1920-wide take, records soft. If the result looks blurry, make the stage window bigger.

## One renderer records, and it is the one making the sound

The record command reaches every renderer attached, and on an ordinary desk that is at least two — the stage, and the panel's own preview. Only the unmuted one acts on it.

That is the same rule the mute already draws rather than a second one: a monitor is a page that makes no sound, and what a take is supposed to contain is what the room heard. It follows that a stage muted because OBS *is* monitoring the browser source will not record — and should not, because OBS is recording it.

The voice and the processed BGM meet before that mute and the recording tap. A take made by the audible renderer therefore contains both at the same levels heard from the page, including the BGM-only libsonare effects. See [Background music](bgm.md).

## mp4, or the truth about what it is

The take is encoded in the browser, and asked for as MP4 first: `avc1` video with AAC audio, which opens in everything and drops into an editor without a conversion step.

A build with no H.264 encoder falls back to WebM, and the file is then named `.webm`. Writing `.mp4` over a WebM stream would be the one outcome worse than either — a file that will not open, mislabelled.

The extension is decided by what the encoder actually chose rather than by what was asked for, which is why the file has no name on disk until the first chunk arrives. A take that no renderer acted on — every attached one being a muted monitor — therefore leaves nothing behind, rather than an empty file with a timestamp in its name.

## Where it lands

`show/recordings/`, beside the slides, scripts and motions. It is git-ignored for a stronger reason than size: a take is minutes of video of a purchased avatar speaking in a cloned voice.

The name is the script the queue came from, then the time it was started:

```
show/recordings/opening-20260829-142530.mp4
```

`--recordings` moves the directory, on the same footing as `--slides` and `--motions`. The native shell has `Window → Open Recordings Folder`.

## Stopping

The take ends a moment after the last line — long enough for the mouth to close and the character to come back to rest, because a cut on the same frame as the last syllable reads as a dropped connection. A line queued inside that moment carries the recording on rather than ending it.

Turning **Stop at the end of the script** off leaves it running until the Stop button.

Either way the file stays open for a second or so after the stop. The encoder is still holding frames when it is told to wind down, and closing on the command rather than on the last chunk would truncate every take by exactly that much. The panel's byte count is what says when it has finished: it is what has landed on disk, which is the only figure that can tell a recorder that is still going from one that has quietly stopped.

## What comes out is variable frame rate

A frame exists when the compositing canvas is redrawn, and nothing redraws it faster than the screen refreshes. Ask for 60 fps on a renderer sitting on a 50 Hz display and you get 50.

The encoder timestamps frames when they were actually drawn, so the file ends up variable-rate with an average like 49.36 fps. **The contents are correct.** Audio packet spacing, video frame spacing and both stream start times all line up, and the mouth matches the voice from one end of a take to the other.

It only goes wrong handed to a player or an editor that reads it as a fixed rate. Laying out 50 fps of real frames as though there were 60 changes how fast the picture advances, and the sound appears to run ahead of it. Nothing in the file is broken, which is why measuring it turns up nothing — the giveaway is the odd fraction `ffprobe` reports as `avg_frame_rate`.

## Put it through once afterwards

Making it constant-rate removes it. Match the rate to the refresh rate it was recorded on.

```sh
ffmpeg -i show/recordings/<take>.mp4 \
  -fps_mode cfr -r 50 -c:v libx264 -preset veryfast -crf 18 -c:a copy \
  show/recordings/<take>-cfr50.mp4
```

The audio is not re-encoded. There is no reason to touch it, and the voice is the last thing this runtime wants to spend quality on.

The file usually gets much smaller — 615 MB became 147 MB for an eighteen-minute commentary. That is not quality thrown away. The browser encodes while it streams, so it can neither look ahead nor use B-frames, and it goes on spending bits through every second nothing moved; on a take that is mostly a still document, that is most of them.

Setting the display to 60 Hz is the answer that needs no conversion at all. This pass is enough if all you want is the drift gone.

## Next

- [Scripts](scripts.md) — what is being loaded
- [Slides](slides.md) — the document behind the character
- [The surfaces](surfaces.md) — which page is the one that records
