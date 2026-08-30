# Lines and cues

A cue changes one part of the broadcast at a position inside one spoken line. The legacy performance shorthand and the typed forms use the same brackets:

```
[hello]Good evening. [@camera bust]Tonight I want to talk about this. [@bgm play]
```

![A performance written into a line](../images/cues.svg)

A bracketed cue starts its action where it is written. There is no other way to place one mid-sentence: a second turn would put a gap and a breath in the middle of a clause, and a separate command cannot know when the first half has been said — only the renderer knows how long that takes.

## Cue forms

`[performanceId]` remains the shorthand for `[@perform performanceId]`. Typed cues make the action explicit:

| Syntax | Action |
|---|---|
| `[@perform id]` | Start a named performance. |
| `[@expression id]` | Set a drawn expression. |
| `[@gesture id]` | Start a body motion. |
| `[@hop id]` | Start a hop. |
| `[@camera face\|bust\|upper\|full]` | Change the camera framing. |
| `[@slide 3]` | Move to an absolute, 1-based document page. |
| `[@bgm play]` | Resume the currently selected BGM track. |
| `[@bgm play track filename]` | Select and play a track. The remainder is the filename, so spaces and Japanese characters are allowed. |
| `[@bgm pause]` | Pause the selected BGM track. |
| `[@bgm stop]` | Stop the selected BGM track and return it to the start. |

Typed cues are part of the ordinary `text` field. They travel through `speak`, `say`, `queue`, and script lines; no extra MCP or CLI operation is needed. The `[` and `]` characters are reserved because they delimit a cue.

For `perform`, `expression`, `gesture`, and `hop`, everything after the cue kind is the id. That lets a loaded motion such as `big wave` be written as `[@gesture big wave]`; spaces and Japanese characters are valid in these dynamic ids.

A cue carries no `side`, so a movement started mid-sentence draws its hand the way it always has. A line that needs a particular one names the movement in the line's own `gesture` or `perform` and pins it there — see [Which hand](commands.md#which-hand).

Camera and slide cues act at the point in the line where they occur. `room`, `backdrop`, `deck`, and `place` remain line-start `stage` setup because they describe the state for the line rather than a point inside it. BGM volume, looping, fade durations, and libsonare DSP remain panel and MCP mixer settings. Inline BGM play cues use the current fade settings. Relative slides are not inline cues; use an absolute page.

## Brackets are reserved, and nothing inside them is ever spoken

That is the reason the syntax exists in this shape rather than a detail of it. The caller is a language model, everything it writes goes to the mouth, and a character reading a stage direction out loud is the failure the design is arranged around.

So it is guaranteed twice. A line whose markup does not parse fails the schema and the command is dropped, which keeps the character quiet and tells the caller. The parser behind that is total, so a line arriving by any other route comes out with its markup removed rather than read. There is no flag that turns parsing off, and no second field a line can arrive on.

## A cue's position is a fraction, not a time

It rides the mouth's own clock, so it stays where it was written when the line turns out longer than the estimate: a supplied `reading` is a different length, and TTS audio is a different length again. Both rows in the figure above put `[explain]` at the same 35 % of the utterance and therefore at a different second.

An id absent from the active avatar's vocabulary does nothing. Mid-sentence, a typo should leave the current face or movement alone.

## Reading

Where the writing does not determine the pronunciation, `reading` carries the kana. The example is Japanese because the field exists for Japanese: the same characters are read more than one way, and only the writer knows which.

```sh
yarn ctl say "紅い月" --reading "あかいつき"
```

`reading` carries no cues of its own. Cues belong to the text, which is the thing being performed; the reading is only how it sounds.

## Next

- [Performances](performances.md) — the table the ids come from
- [Speech](speech.md) — what happens to a line on the way to the speakers
