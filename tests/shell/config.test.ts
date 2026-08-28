import { describe, expect, it } from 'vitest';
import {
  checkoutPaths,
  controlPort,
  controlURL,
  expectedRoots,
  isAllowedPageURL,
  loopbackURL,
  portFromEnvironment,
  stageURL,
} from '@/shell/config';

/**
 * The addresses the native shell is allowed to reach, and the paths it works
 * from.
 *
 * Everything here is a licence condition rather than a preference. The avatars
 * used for validation may not be republished, so the renderer must not be
 * reachable from another machine — which means no host is configurable, only a
 * port, and a window may only ever be pointed at one of two exact loopback
 * paths.
 */

describe('reading a port from the environment', () => {
  it('takes an integer in range', () => {
    expect(portFromEnvironment('9000', 8765)).toBe(9000);
  });

  it('falls back for an unset or empty variable', () => {
    expect(portFromEnvironment(undefined, 8765)).toBe(8765);
    expect(portFromEnvironment('', 8765)).toBe(8765);
  });

  it('falls back rather than failing for anything that is not a port', () => {
    // There is nowhere useful to report this to: the shell is a window
    // application and this is read before one exists. A default that works
    // beats a dialog nobody can act on.
    for (const bad of ['nope', '0', '-1', '65536', 'NaN', '  ']) {
      expect(portFromEnvironment(bad, 8765)).toBe(8765);
    }
  });

  it('takes the ends of the range', () => {
    expect(portFromEnvironment('1', 8765)).toBe(1);
    expect(portFromEnvironment('65535', 8765)).toBe(65535);
  });

  it('reads a leading number the way parseInt does, which is the lenient half', () => {
    // Pinned rather than endorsed. `8765` from `8765 ` is what anyone meant;
    // `80` from `80.5` is not, and is the price of the same rule. Neither can
    // reach anything off this machine, which is what the strictness here is
    // actually for.
    expect(portFromEnvironment('8765 ', 1)).toBe(8765);
    expect(portFromEnvironment('80.5', 1)).toBe(80);
  });

  it('defaults the one port the runtime actually opens', () => {
    // One rather than two: the speech sidecar answers on a socket, and where
    // that is comes from `speechEndpoint` rather than from here.
    expect(controlPort(undefined)).toBe(8765);
    expect(controlPort('9100')).toBe(9100);
  });
});

describe('the addresses', () => {
  it('always names loopback, whatever the port', () => {
    expect(loopbackURL(8765, '/panel/')).toBe('http://127.0.0.1:8765/panel/');
    expect(controlURL(9000)).toBe('http://127.0.0.1:9000/api/state');
  });

  it('opens the stage silent by putting it on the URL, not by telling the page', () => {
    expect(stageURL(8765, false)).toBe('http://127.0.0.1:8765/monitor/');
    // The same flag every browser source has always understood, so a renderer
    // that is quiet is quiet for a reason its address states.
    expect(stageURL(8765, true)).toBe('http://127.0.0.1:8765/monitor/?mute=1');
  });
});

describe('what a window may be pointed at', () => {
  const allowed = (url: string) => isAllowedPageURL(url, '/panel/', 8765);

  it('accepts the exact page it was opened on', () => {
    expect(allowed('http://127.0.0.1:8765/panel/')).toBe(true);
  });

  it('accepts a query and a fragment, which are page settings', () => {
    expect(allowed('http://127.0.0.1:8765/panel/?tab=queue')).toBe(true);
    expect(allowed('http://127.0.0.1:8765/panel/#top')).toBe(true);
    expect(isAllowedPageURL('http://127.0.0.1:8765/monitor/?mute=1', '/monitor/', 8765)).toBe(true);
  });

  it('refuses another page on the same server', () => {
    for (const url of [
      'http://127.0.0.1:8765/',
      'http://127.0.0.1:8765/panel',
      'http://127.0.0.1:8765/panel/index.html',
      'http://127.0.0.1:8765/api/state',
      'http://127.0.0.1:8765/monitor/',
    ]) {
      expect(allowed(url)).toBe(false);
    }
  });

  it('refuses another port, another host and another scheme', () => {
    // `localhost` is refused along with the rest: it is a name, it can resolve
    // to something else, and nothing here ever needs it.
    for (const url of [
      'http://127.0.0.1:5173/panel/',
      'http://localhost:8765/panel/',
      'http://192.168.1.10:8765/panel/',
      'https://127.0.0.1:8765/panel/',
      'file:///panel/',
      'about:blank',
    ]) {
      expect(allowed(url)).toBe(false);
    }
  });

  it('refuses anything that is not a URL at all', () => {
    expect(allowed('')).toBe(false);
    expect(allowed('/panel/')).toBe(false);
  });
});

describe('the checkout', () => {
  const paths = checkoutPaths('/work/hashidate/src/shell/config.ts');

  it('finds the repository root two directories up from this module', () => {
    expect(paths.root).toBe('/work/hashidate');
    expect(paths.dist).toBe('/work/hashidate/dist');
    expect(paths.server).toBe('/work/hashidate/src/server/main.ts');
  });

  it('points at the loader rather than at tsx own launcher', () => {
    // The launcher starts a second process to do the work, and a signal sent to
    // the first does not always reach it. See `ControlProcess.controlArgs`.
    expect(paths.tsx).toBe('/work/hashidate/node_modules/tsx/dist/loader.mjs');
  });

  it('names the three show directories an operator fills', () => {
    expect(paths.slides).toBe('/work/hashidate/show/slides');
    expect(paths.scripts).toBe('/work/hashidate/show/scripts');
    expect(paths.motions).toBe('/work/hashidate/show/motions');
  });

  it('answers what a server on this checkout would say it is serving', () => {
    // Compared against the snapshot of whatever is already on the port, which
    // is the whole reason a second checkout cannot be adopted by mistake.
    expect(expectedRoots(paths)).toEqual({
      document: '/work/hashidate/dist',
      slides: '/work/hashidate/show/slides',
      scripts: '/work/hashidate/show/scripts',
      motions: '/work/hashidate/show/motions',
      recordings: '/work/hashidate/show/recordings',
    });
  });
});
