import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { same } from '@/i18n';
import { EMPTY } from '@/panel/hooks';
import { formatAvatarStatus, InspectTab } from '@/panel/inspect/InspectTab';
import type { Snapshot } from '@/protocol';

function renderInspect(status: Snapshot['avatar']): string {
  return renderToStaticMarkup(
    createElement(InspectTab, {
      snapshot: {
        ...EMPTY,
        connected: true,
        vocabulary: { avatar: { id: 'demo', label: same('Demo') } },
        avatar: status,
      },
    }),
  );
}

describe('avatar status in the inspect panel', () => {
  it.each(['idle', 'loading', 'ready', 'failed'] as const)(
    'keeps the %s phase visible',
    (phase) => {
      expect(formatAvatarStatus({ phase })).toBe(phase);
    },
  );

  it('keeps a load failure visible with its bounded error', () => {
    expect(formatAvatarStatus({ phase: 'failed', error: 'missing model.glb' })).toBe(
      'failed: missing model.glb',
    );
  });

  it('shows no status when the renderer has not reported one', () => {
    expect(formatAvatarStatus(null)).toBe('');
    expect(formatAvatarStatus(undefined)).toBe('');
  });
});

describe('InspectTab avatar status display', () => {
  it('shows loading alongside the current avatar', () => {
    expect(renderInspect({ phase: 'loading' })).toContain('Demo · loading');
  });

  it('shows a failed load and its error alongside the current avatar', () => {
    expect(renderInspect({ phase: 'failed', error: 'missing model.glb' })).toContain(
      'Demo · failed: missing model.glb',
    );
  });
});
