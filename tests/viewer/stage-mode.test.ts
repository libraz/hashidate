import { describe, expect, it } from 'vitest';
import { FULL_FRAME, FULL_SLIDE } from '@/viewer/scene/placement';
import { parseDeck, parsePlace, parseSize, readStageMode } from '@/viewer/stage-mode';

/**
 * How the viewer was asked to present itself.
 *
 * Everything here is read from a URL typed into a field inside OBS, or built by
 * the panel for an iframe. There is nowhere for an error to be reported to in
 * either case, so the rule throughout is that a value which does not parse
 * degrades to something that still renders.
 */

describe('parseSize', () => {
  it('reads a source size', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseSize('640x360')).toEqual({ width: 640, height: 360 });
  });

  it('falls back to filling the window for anything it cannot read', () => {
    for (const raw of [null, '', '1920', '1920*1080', 'axb', '1920x', 'x1080', '1920 x 1080']) {
      expect(parseSize(raw), String(raw)).toBeNull();
    }
  });

  it('refuses a size the GPU could not back', () => {
    // The device pixel ratio multiplies whatever lands here, so a typo asks for
    // a framebuffer in the tens of gigabytes and takes the tab with it.
    expect(parseSize('99999x99999')).toBeNull();
    expect(parseSize('7680x4320')).toEqual({ width: 7680, height: 4320 });
  });
});

describe('parseDeck', () => {
  it('takes an id it cannot check, because only the server can', () => {
    // What documents exist is whatever was dropped in a directory five minutes
    // ago. An id that turns out not to be one comes back as an error in the
    // slide report rather than as nothing happening.
    expect(parseDeck('intro')).toBe('intro');
    expect(parseDeck('2026-01-05_進行台本')).toBe('2026-01-05_進行台本');
    expect(parseDeck('資料')).toBe('資料');
  });

  it('has no document for the spellings that name none', () => {
    for (const raw of [null, '', '   ', 'none']) {
      expect(parseDeck(raw), String(raw)).toBeNull();
    }
  });

  it('trims what a query string picked up around the id', () => {
    expect(parseDeck(' intro ')).toBe('intro');
  });

  it('leaves what an id may be to the server that owns the directory', () => {
    // A copy of that rule here is a copy that will disagree — the server's list
    // was widened once already to allow 資料.pdf. An id that names nothing
    // degrades the way a mistyped room does: the fetch fails and the reason
    // lands in the slide report.
    for (const raw of ['../etc/passwd', 'a/b', 'a b', 'x'.repeat(200)]) {
      expect(parseDeck(raw), raw).toBe(raw);
    }
  });
});

describe('parsePlace', () => {
  it('reads an anchor and two fractions of the frame', () => {
    expect(parsePlace('bottom-right:0.32x0.6')).toEqual({
      avatar: { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0 },
      slide: FULL_SLIDE,
    });
  });

  it('places the character, and leaves the document the whole frame', () => {
    // The document is what a source configured this way is for; the rectangle
    // is where the picture in front of it goes.
    expect(parsePlace('top-left:.5x.5').slide).toEqual(FULL_SLIDE);
  });

  it('falls back to the full frame for anything it cannot read', () => {
    for (const raw of [
      null,
      '',
      'bottom-right',
      'bottom-right:0.32',
      'nowhere:0.3x0.3',
      'CENTER:0.3x0.3',
      'bottom-right:axb',
      'bottom-right:0.3*0.3',
      'bottom-right:0.3x0.3 ',
    ]) {
      expect(parsePlace(raw), String(raw)).toEqual({ avatar: FULL_FRAME, slide: FULL_SLIDE });
    }
  });

  it('falls back rather than clamping a fraction the wire would refuse', () => {
    // Out of range is a typo, not an instruction: nobody means "0.02 of the
    // frame", and a character that is a smudge in a corner is harder to
    // diagnose from the stream than one that is simply not moved at all.
    expect(parsePlace('bottom-right:0.02x0.6').avatar).toEqual(FULL_FRAME);
    expect(parsePlace('bottom-right:0.5x2').avatar).toEqual(FULL_FRAME);
  });
});

describe('readStageMode', () => {
  it('is the stage with no query at all, because the page is the output', () => {
    // The console is what makes this a tool, and a default that has to be
    // switched off before going to air is a default that eventually goes to air.
    expect(readStageMode('')).toMatchObject({ console: false, size: null, muted: false });
  });

  it('carries the document and the layout a source was configured with', () => {
    // Both belong to the browser source rather than to the session, for the
    // reason the room does: a scene that is the slide segment should be the
    // slide segment every time OBS switches to it.
    expect(readStageMode('?deck=intro&place=bottom-right:0.32x0.6')).toMatchObject({
      deck: 'intro',
      place: {
        avatar: { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0 },
        slide: FULL_SLIDE,
      },
    });
    expect(readStageMode('')).toMatchObject({ deck: null, place: { avatar: FULL_FRAME } });
  });

  it('brings the console back when asked', () => {
    for (const raw of ['?console=1', '?console=true', '?console']) {
      expect(readStageMode(raw).console, raw).toBe(true);
    }
  });

  it('opens the telemetry readout when the source was configured with it', () => {
    for (const raw of ['?debug=1', '?debug=true', '?debug']) {
      expect(readStageMode(raw).debug, raw).toBe(true);
    }
    expect(readStageMode('').debug).toBe(false);
    expect(readStageMode('?debug=0').debug).toBe(false);
  });

  it('keeps the readout and the console apart', () => {
    // Two flags because they answer different questions: the console reaches
    // into the scene and needs a page nobody is watching, the readout only
    // reads and is safe over a live frame.
    expect(readStageMode('?debug=1')).toMatchObject({ debug: true, console: false });
    expect(readStageMode('?console=1')).toMatchObject({ debug: false, console: true });
  });

  it('reads the mute the panel’s preview is opened with', () => {
    // The preview is a second renderer of the same commands. Without this the
    // operator hears every line twice, a fraction of a second apart.
    expect(readStageMode('?mute=1').muted).toBe(true);
    expect(readStageMode('?mute').muted).toBe(true);
  });

  it('treats an explicitly-off flag as off, so a URL can carry one either way', () => {
    for (const raw of ['?mute=0', '?mute=false', '']) {
      expect(readStageMode(raw).muted, raw).toBe(false);
    }
    expect(readStageMode('?console=0').console).toBe(false);
    expect(readStageMode('?console=false').console).toBe(false);
  });

  it('reads the transparent background a source over a game capture is opened with', () => {
    for (const raw of ['?transparent=1', '?transparent=true', '?transparent']) {
      expect(readStageMode(raw).transparent, raw).toBe(true);
    }
    // Off by default, because the default is a page somebody opened to look at.
    expect(readStageMode('').transparent).toBe(false);
    expect(readStageMode('?transparent=0').transparent).toBe(false);
  });

  it('keeps the transparent background and the room independent', () => {
    // Not a fifth set. A room is opaque and covers this either way, so the flag
    // only decides what the *absence* of a room looks like — which means a
    // source can carry both and mean it.
    expect(readStageMode('?transparent=1&backdrop=none')).toMatchObject({
      transparent: true,
      backdrop: null,
    });
    expect(readStageMode('?transparent=1').backdrop).toBe(null);
  });

  it('still reads a browser source configured before the default changed', () => {
    // `?stage=1` says nothing the default does not, and is accepted rather than
    // rejected: a URL already typed into OBS should not quietly stop working.
    expect(readStageMode('?stage=1&mute=1')).toMatchObject({
      console: false,
      muted: true,
      size: null,
    });
    expect(readStageMode('?stage=1&console=1').console).toBe(true);
  });
});
