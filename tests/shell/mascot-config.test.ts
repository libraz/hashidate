import { describe, expect, it } from 'vitest';
import { isAllowedPageURL, MASCOT_PATH, mascotPageURL } from '@/shell/config';

/**
 * The one address the mascot window opens, and everything beside it that the
 * window refuses.
 *
 * The mascot shows the viewer's own page, which is the root of the server and
 * the page every other switch hangs off. So unlike the panel and the stage,
 * whose query is theirs to use, the root is allowed in this one shape only: a
 * mascot window that could be steered to `/?demo=1` would be a bare viewer in
 * a frameless window nobody can close.
 */

const allowed = (url: string) => isAllowedPageURL(url, MASCOT_PATH, 8765);

describe('where the mascot window opens', () => {
  it('is the transparent mascot page', () => {
    expect(mascotPageURL(8765, { muted: false })).toBe(
      'http://127.0.0.1:8765/?mascot=1&transparent=1',
    );
  });

  it('says so on the address when it has been silenced', () => {
    // Whether a renderer makes a sound is read off its URL and nothing else.
    expect(mascotPageURL(8765, { muted: true })).toBe(
      'http://127.0.0.1:8765/?mascot=1&transparent=1&mute=1',
    );
  });

  it('follows the port', () => {
    expect(mascotPageURL(9000, { muted: false })).toBe(
      'http://127.0.0.1:9000/?mascot=1&transparent=1',
    );
  });
});

describe('what the mascot window may be pointed at', () => {
  it('accepts both addresses it is opened on', () => {
    expect(allowed(mascotPageURL(8765, { muted: false }))).toBe(true);
    expect(allowed(mascotPageURL(8765, { muted: true }))).toBe(true);
  });

  it('refuses the root in any other shape', () => {
    for (const url of [
      'http://127.0.0.1:8765/',
      'http://127.0.0.1:8765/?mascot=1',
      'http://127.0.0.1:8765/?transparent=1',
      'http://127.0.0.1:8765/?transparent=1&mascot=1',
      'http://127.0.0.1:8765/?mascot=1&transparent=1&mute=0',
      'http://127.0.0.1:8765/?mascot=1&transparent=1&mute=1&demo=1',
      'http://127.0.0.1:8765/?mascot=1&transparent=1&demo=1',
      'http://127.0.0.1:8765/?mascot=1&transparent=1#console',
      'http://127.0.0.1:8765/?mute=1',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('refuses another page with the same query', () => {
    for (const url of [
      'http://127.0.0.1:8765/panel/?mascot=1&transparent=1',
      'http://127.0.0.1:8765/monitor/?mascot=1&transparent=1',
      'http://127.0.0.1:8765/index.html?mascot=1&transparent=1',
      'http://127.0.0.1:8765/api/state?mascot=1&transparent=1',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('refuses another port, another host and another scheme', () => {
    for (const url of [
      'http://127.0.0.1:5173/?mascot=1&transparent=1',
      'http://localhost:8765/?mascot=1&transparent=1',
      'http://192.168.1.10:8765/?mascot=1&transparent=1',
      'http://0.0.0.0:8765/?mascot=1&transparent=1',
      'https://127.0.0.1:8765/?mascot=1&transparent=1',
      'file:///?mascot=1&transparent=1',
      'about:blank',
      'not a url',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('does not let the mascot shape onto the other windows', () => {
    expect(isAllowedPageURL(mascotPageURL(8765, { muted: false }), '/panel/', 8765)).toBe(false);
    expect(isAllowedPageURL(mascotPageURL(8765, { muted: true }), '/monitor/', 8765)).toBe(false);
  });

  it('leaves the other windows their query', () => {
    expect(isAllowedPageURL('http://127.0.0.1:8765/panel/?tab=queue', '/panel/', 8765)).toBe(true);
    expect(isAllowedPageURL('http://127.0.0.1:8765/monitor/?mute=1', '/monitor/', 8765)).toBe(true);
  });
});
