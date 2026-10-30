import { describe, expect, it } from 'vitest';
import { serverPort } from '@/server/port';
import { controlPort } from '@/shell/config';

/**
 * Where the control server listens, by the one rule every launcher reads the
 * variable by — so `make dev`, `yarn dev`, `make stop` and the shell agree.
 */

describe('the control server port', () => {
  it('takes --port over the environment', () => {
    expect(serverPort('9100', '9200')).toBe(9100);
  });

  it('takes a valid HASHIDATE_CONTROL_PORT when --port is absent', () => {
    expect(serverPort(undefined, '9200')).toBe(9200);
  });

  it('falls back to the default without either', () => {
    expect(serverPort(undefined, undefined)).toBe(8765);
  });

  it('reads the variable exactly as the shell and the vite proxy do', () => {
    for (const value of [undefined, '', '9200', 'nope', '0', '65536', '8765 ', '80.5']) {
      expect(serverPort(undefined, value)).toBe(controlPort(value));
    }
  });

  it('refuses a --port that is not a port rather than replacing it', () => {
    for (const bad of ['nope', '0', '65536', '']) {
      expect(serverPort(bad, '9200')).toBeNull();
    }
  });
});
