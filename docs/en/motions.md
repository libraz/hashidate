# Motions

A gesture of your own, in a file, on top of the ones this project ships.

Drop a YAML file in `show/motions/` and it becomes a gesture under its own filename — playable by `gesture`, nameable from a line, listed in the vocabulary beside the built-in ones. `--motions <dir>` moves the directory anywhere. Nothing in it is tracked.

```sh
yarn ctl motions             # what the server can see
yarn ctl gesture salute      # play it
```

The renderer reads the directory when it connects, so the loop is: edit the file, reload the page.

## It is keyframes, and the built-in table is not

A built-in gesture is a function of time. `wave` is a sine whose amplitude decays, because a wave held at constant amplitude for three seconds is a metronome rather than a greeting; `nod` is a damped oscillation, because one beat reads as a twitch and it is the second, smaller beat that makes it read as agreement. Those are not values anybody types into a file. They were arrived at by watching a render, and the comments beside them in `src/engine/motion/gestures.ts` say which failure each number exists to prevent.

So this format is poses at times, interpolated between — which is what a person editing a text file can actually control. It expresses less than the built-in form does, and is meant to. The gesture table is not migrated to it and will not be: a keyframed `nod` is a nod with the tuning taken out.

Two consequences follow from the same reasoning:

**A name already in the gesture table is refused**, rather than shadowing it. What the performance table names has to keep meaning what it meant, or a script written against this runtime does something else on the machine next to it.

**The idle autopilot never picks one.** It plays a gesture nobody asked for, so it may only draw from the set that was watched on a render. A motion is played when it is named.

## What a file looks like

```yaml
label: { en: Salute, ja: 敬礼 }
group: greeting
lead: 0.3
hold: 1.4

frames:
  - at: 0
    arms:
      R:
        upperArm: [0.30, -0.90, 0.10]
        lowerArm: [0.17, -0.95, 0.26]
        hand:     [0.13, -0.96, 0.24]
    fingers:
      R: { thumb: 0.2, index: 0.1, middle: 0.1, ring: 0.12, little: 0.16 }

  - at: 0.45
    arms:
      R:
        upperArm: [0.46, -0.42, 0.32]
        lowerArm: [0.10, 0.86, 0.50]
        hand:     [0.05, 0.72, 0.69]
        palm:     [-0.10, 0.30, -0.95]
        twist: 0.2
    spine:
      head:  [0.03, 0, 0]
      chest: [0.02, 0, 0]
```

| Field | What it is |
|---|---|
| `label` | Both languages, like everything user-visible in the engine. |
| `group` | One of `reaction`, `greeting`, `explain`, `emote`, `cute`, `pose`. |
| `lead` | Seconds of entrance. A floor — the real lead scales with how far the arms have to travel. |
| `hold` | Seconds held at full weight before the exit begins. |
| `sustain` | Hold the pose until something else is asked for, instead of running out. |
| `loop` | Run the keyframes round again rather than settling on the last one. |
| `frames` | Poses, `at` seconds from the start, in ascending order. |

### Directions, not positions

`arms` names the four links shoulder to hand as directions in **character space**: x outward from the midline, y up, z forward. They are normalised on the way in, so their length does not matter and only their bearing does. `palm` is which way the palm faces, and it is worth stating — aiming the hand only says where the fingers point, and the roll about that axis falls out as an accident otherwise.

`fingers` is curl per finger, 0 straight and 1 fully closed. `spine` is additive offsets in radians per slot: `hips`, `spine`, `chest`, `neck`, `head`.

Sides are written out. The built-in table authors one pose and mirrors it onto whichever hand is free, and it can do that because every entry was checked on both; a file says `L` or `R` and gets it.

### Unstated is not zero

Every field is optional, and one that a keyframe leaves out is not "back to rest" — it is unstated, and whichever neighbouring keyframe does state it is used unchanged. That is what lets a motion move the arms over four keyframes while stating the spine once. Fading toward a value nobody wrote down is the reading that produces movement nobody authored.

### What is deliberately missing

`reach` and `point` — the two things the built-in table solves against a particular avatar's measured proportions. An authored reach that misses does not look approximate; it puts the hand inside the face. The gesture table has the notes that make those authorable and a file dropped in a directory does not. A direction that is wrong costs an arm at an odd angle, which is a thing you can see and fix.

## Variation

A gesture is played with a little variation so that two playbacks are not identical. For a keyframe track that means one thing and not the other:

- `rate` scales **time** — the only reading of "faster" a keyframe track has.
- `scale` reaches the **spine** alone. A direction has no amplitude to vary; scaling one aims it somewhere else, which is a different pose rather than the same pose done smaller.

## When it does not work

A file that will not parse is listed with its reason rather than dropped, because a motion that is simply absent reads as a filename typed wrong — which is the one thing it is not.

```
$ yarn ctl motions
  salute           Salute           [greeting] 2f
  broken           group: invalid option
```

A loop whose first and last keyframes differ snaps once per cycle. Nothing checks for it: how close is close enough is a judgement about a render.

## Next

- [Performances](performances.md) — the composed vocabulary a gesture is a part of
- [Commands](commands.md) — `gesture`, and where a motion can be named
