# Performances

What a turn is *delivered with* is usually a **performance** — a named face and movement together, like Delighted or Dozing off.

![What a performance is made of](../images/performances.svg)

The layers underneath are separate for good reasons: an emotion is a continuous blend that persists, a gesture is discrete and ends, a hop moves the whole skeleton. None of them is the shape a caller thinks in. Asking for Delighted is one call; asking for joy 0.9 with a cheer gesture and three hops of 45 mm is four, and the second one is a rig question dressed up as a script.

## The groups say what kind of thing an entry is

Mood (a face and nothing else, which is most of what watching a character actually looks like), Reaction, Greeting, Explaining, Feeling, Mannerism, and Pose, which is held until something else is asked for.

Every gesture the engine has appears in at least one performance, and a test says so: a movement with no face attached is one the autopilot would eventually play deadpan.

## A performance is a state, not an event

Starting one ends the last — the pose comes down, a raised effect is lowered, a droop on the eyelids is released.

Its mood is the exception and persists, for the same reason a turn's emotion does: a mood does not end with the sentence that carried it.

## The parts stay reachable

For what the table has no name for, `emotion`, `expression`, `overlay`, `gesture` and `hop` are all still commands of their own. See [Commands](commands.md).

The idle autopilot draws from the same table, so what the character does on its own and what it can be asked to do are one vocabulary. Turn it on with `idle on` and she will keep herself occupied between turns without the caller sending anything.

## Finding out what this avatar has

`GET /api/vocabulary` lists the performances the loaded avatar actually has, grouped. Over MCP the same ids are compiled into the tool schemas, so a model picks from a list rather than inventing one.

```sh
yarn ctl vocab
```

## Next

- [Lines and cues](lines-and-cues.md) — changing performance inside one line
- [Commands](commands.md) — the layers underneath
