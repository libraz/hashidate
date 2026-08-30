import { describe, expect, it } from 'vitest';
import { projectStatus } from '@/mcp/project';
import { bgmState, snapshot } from './harness';

describe('projectStatus BGM projection', () => {
  it('keeps the canonical resolved DSP and degradation marker', () => {
    const status = projectStatus(
      snapshot({
        bgm: bgmState({
          track: 'theme.flac',
          transport: 'playing',
          dsp: {
            toneDb: -2,
            compression: 0.6,
            width: 1.4,
            reverb: { mix: 0.25, decay: 0.7, damping: 0.3 },
          },
          dspDegraded: true,
        }),
      }),
    );

    expect(status.bgm).toMatchObject({
      track: 'theme.flac',
      transport: 'playing',
      dsp: { toneDb: -2, compression: 0.6, width: 1.4 },
      dspDegraded: true,
    });
  });

  it('uses null when the server has no BGM state yet', () => {
    const status = projectStatus(snapshot({ bgm: undefined }));

    expect(status.bgm).toBeNull();
  });
});
