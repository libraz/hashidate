# Use cases

Six things people set this up to do. Each one is the same runtime with a different caller in front of it.

## 1. An AI VTuber that answers chat

The common case, and the one the boundary is drawn for. Your loop reads the chat, asks a model what to say, and hands the answer over. hashidate does the rest.

```sh
yarn ctl say "Good evening. Nothing planned tonight." --perform hello --wait
```

From a program, that is one `POST /api/command`. From an MCP client it is the `speak` tool, and the ids the avatar actually has are already in the tool's schema, so the model picks from a list instead of inventing one. See [The MCP adapter](mcp.md).

Send a whole answer as one batch rather than a line at a time — it is the difference between 1.2 s of silence between lines and 0.3 s. See [Send a whole answer at once](control-api.md#send-a-whole-answer-at-once).

## 2. Commentary over a game capture

The character stands on top of a game capture with nothing behind her, and OBS does the compositing.

```
http://127.0.0.1:8765/?transparent=1&place=bottom-right:0.32x0.6
```

Game or window capture below, that URL as a browser source above. The shot is untouched — only the picture of it gets smaller — so every gesture still plays as it was authored. See [The stage](stage.md#over-a-game).

## 3. A talk given from slides

A PDF goes up behind her and she presents from it. Page turns can ride on the lines, so the deck follows the script rather than an operator.

```sh
yarn ctl deck intro
yarn ctl say "The whole picture first." --slide 2
yarn ctl place avatar --anchor bottom-right --width 0.32 --height 0.6
```

The deck is also readable as text, which is the point of the feature: a model that can read the deck can write the script for it and put the page numbers on the lines. See [Slides](slides.md).

## 4. A scripted segment, with no model at all

Nothing here requires a language model. A shell script is a perfectly good orchestrator, and it is the fastest way to rehearse a segment or to reproduce a bug.

```sh
yarn ctl backdrop night
yarn ctl say "[hello]Good evening. [explain]Tonight I want to talk about this." --camera bust --wait
yarn ctl perform sleepy
```

## 5. Running a broadcast by hand

The panel on `/panel/` is a full operating surface: the script and its history, performances, voice, wardrobe, tuning and readouts, with the avatar, the framing, the set and the idle switch under a live preview. Everything it does goes through the control API, so anything an operator can do from it, an orchestrator can do too. See [Two surfaces](surfaces.md).

## 6. Checking a model you just rigged

What the avatar can be asked for is discovered from its own shapes and meshes, so the vocabulary endpoint is a report on the model.

```sh
yarn ctl avatar manuka
yarn ctl vocab
yarn ctl point 40 25 --extent 0.9 --finger little
yarn ctl watch
```

`strain` in the state says what the last fingertip solve cost each arm, which is how you tell an aim that was met from one the arm could only approximate. See [The control API](control-api.md#what-comes-back).

## Not what it is for

- A complete AI companion. There is no memory, no persona and no conversation here.
- A cloud service. Everything binds to `127.0.0.1` and there is no flag to change that.
- A rigging or authoring tool. That is Blender's job; `tools/blender` is the seam.
