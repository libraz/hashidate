import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/engine/session';
import { stopSpeech } from '@/viewer/stop';

const session = () => ({ interrupt: vi.fn() }) as unknown as Session & { interrupt: () => void };

afterEach(() => vi.unstubAllGlobals());

describe('stopSpeech', () => {
  it('sends interrupt through the control API when connected, leaving the session to the reply', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const s = session();
    await stopSpeech(s, 'online');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/command',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cmd: 'interrupt' }) }),
    );
    expect(s.interrupt).not.toHaveBeenCalled();
  });

  it('interrupts the local session when offline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = session();
    await stopSpeech(s, 'offline');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.interrupt).toHaveBeenCalledOnce();
  });

  it('falls back to the local session when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    const s = session();
    await stopSpeech(s, 'online');
    expect(s.interrupt).toHaveBeenCalledOnce();
  });
});
