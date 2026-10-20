import { describe, expect, it } from 'vitest';
import { EMPTY } from '@/panel/hooks';
import { previewNotice } from '@/panel/preview/Preview';
import type { Snapshot } from '@/protocol';

/**
 * What the preview says over an empty picture.
 *
 * Every combination of the three inputs, because there are only twenty and the
 * order of precedence is the whole of the rule: offline before an empty roster,
 * an empty roster before whatever a renderer last reported.
 */

type Phase = NonNullable<Snapshot['avatar']>['phase'] | null;

const snapshot = (avatars: number, phase: Phase): Snapshot => ({
  ...EMPTY,
  avatars: Array.from({ length: avatars }, (_, i) => ({
    id: `a${i}`,
    label: { en: 'A', ja: 'A' },
  })),
  avatar: phase === null ? null : { phase, error: phase === 'failed' ? 'bad glb' : null },
});

describe('the preview notice', () => {
  const phases: Phase[] = [null, 'idle', 'loading', 'ready', 'failed'];

  it('follows the order of precedence in every combination', () => {
    for (const offline of [true, false]) {
      for (const avatars of [0, 1]) {
        for (const phase of phases) {
          const expected = offline
            ? { key: 'panel.preview.empty.offline' }
            : avatars === 0
              ? { key: 'panel.preview.empty.noAvatar' }
              : phase === 'loading'
                ? { key: 'panel.preview.empty.loading' }
                : phase === 'failed'
                  ? { key: 'panel.preview.empty.failed', error: 'bad glb' }
                  : null;
          expect(
            previewNotice(snapshot(avatars, phase), offline),
            JSON.stringify({ offline, avatars, phase }),
          ).toEqual(expected);
        }
      }
    }
  });

  it('says nothing over a loaded avatar', () => {
    expect(previewNotice(snapshot(1, 'ready'), false)).toBeNull();
  });
});
