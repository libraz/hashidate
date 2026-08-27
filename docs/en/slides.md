# Slides

A PDF put up behind the character, so she can present from it.

![The layers of the output frame](../images/frame.svg)

It is flat. The page is not geometry in the room and not a texture on a screen somewhere in the scene — it is a DOM layer directly behind the render, at the frame's own resolution. Everything that would otherwise happen to it on the way through a 3D pipeline is what makes slide text unreadable: tone mapping moves the white, filtering softens strokes a pixel wide, and a page turn becomes a texture upload rather than an image swap. Drawing it flat costs the ability to tilt it, which no one wanted, and buys type as sharp as the file is.

## Putting one up

Put the documents in `slides/` — `--slides <dir>` moves that anywhere, including outside the repository, and either way they are ignored by git. A document's id is its filename without the extension.

```sh
yarn ctl deck intro          # up, at page 1
yarn ctl slide               # next
yarn ctl slide prev
yarn ctl slide 12
yarn ctl deck none           # down
```

While a document is up it takes the place of the set: both go behind the character, and the renderer puts the room away for the duration and brings it back unchanged when the document comes down. Two commands still, so a segment that goes to slides and back is one command each way and neither has to restate the other.

The character moves out of the way with `place`, which shrinks the picture rather than the shot. See [The stage](stage.md#where-she-stands-in-the-frame).

## A page can ride on a line

Which is what makes a document follow a script rather than an operator:

```sh
yarn ctl say "The whole picture first." --slide 2
```

That page is **absolute, and there is deliberately no relative form on a line.** A queued line can be dropped, reordered or sent round again, and a "next page" written into one means a different page every time the script is touched — the rest of the deck slips by one and nothing in the queue says why.

`slide`'s relative form is for the operator with a hand on an arrow key, who is reacting to what is on screen rather than describing it.

## Fonts

A deck that names a font instead of carrying it — which a Japanese one usually does, because the machine that made it had the font installed — is drawn from the character maps and standard outlines that ship with pdf.js, served out of the installed package at `/pdfjs/`. Without them such a page draws with its text simply absent, and nothing says so.

## A document can be read rather than shown

`GET /api/decks/<id>/text` returns the words on the pages, extracted without rasterising anything, and the MCP layer offers the same thing as a tool.

That is the whole point of the feature: a model that can read the deck can write the script for it, and put the page numbers on the lines.

```sh
curl '127.0.0.1:8765/api/decks/intro/text?from=1&to=3'
```

## Next

- [The stage](stage.md) — the set the document displaces
- [The MCP adapter](mcp.md) — reading a deck from a model
