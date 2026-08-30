// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RecordTab,
  recordingError,
  recordingFrameValue,
  recordingRateValue,
} from '@/panel/record/RecordTab';
import type { Snapshot } from '@/protocol';

function recording(over: Partial<NonNullable<Snapshot['recording']>> = {}) {
  return {
    session: 'r-test',
    file: '/tmp/take.mp4',
    mime: 'video/mp4',
    since: 1,
    bytes: 1024,
    autoStop: true,
    width: 1920,
    height: 1080,
    fps: 30,
    error: null,
    ...over,
  } satisfies NonNullable<Snapshot['recording']>;
}

function snapshot(recordingState: Snapshot['recording'] = null): Snapshot {
  return {
    connected: false,
    viewers: 0,
    seq: 0,
    state: {},
    vocabulary: {},
    events: [],
    voice: null,
    tuning: null,
    placement: null,
    avatars: [],
    decks: [],
    slides: null,
    speech: 'absent',
    queue: [],
    airing: [],
    paused: false,
    recording: recordingState,
  };
}

describe('recording panel state', () => {
  it('uses the open take dimensions instead of the panel default', () => {
    expect(recordingFrameValue(recording({ width: 1280, height: 720 }), '1920x1080')).toBe(
      '1280x720',
    );
    expect(recordingRateValue(recording({ fps: 60 }), '30')).toBe('60');
  });

  it('keeps the pending panel choices when no take is open', () => {
    expect(recordingFrameValue(null, '1280x720')).toBe('1280x720');
    expect(recordingRateValue(undefined, '60')).toBe('60');
  });

  it('marks an output absent from the presets as custom', () => {
    const open = recording({ width: 1600, height: 900, fps: 24 });
    expect(recordingFrameValue(open, '1920x1080')).toBe('custom');
    expect(recordingRateValue(open, '30')).toBe('custom');
  });

  it('exposes server recording failures as state', () => {
    expect(recordingError(recording({ error: 'disk full' }))).toBe('disk full');
    expect(recordingError(recording())).toBeNull();
    expect(recordingError(null)).toBeNull();
  });
});

describe('RecordTab rendering', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it('shows the server-selected size and rate while another renderer started the take', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        createElement(RecordTab, {
          snapshot: snapshot(recording({ width: 1280, height: 720, fps: 60 })),
          refresh: () => {},
        }),
      );
    });

    // A radio group and not a tab strip: naming an output size selects nothing
    // for a screen reader to move to. See `Segmented`.
    expect(
      host.querySelector('[role="radiogroup"][aria-label="Output size"] [aria-checked="true"]')
        ?.textContent,
    ).toBe('1280×720');
    expect(
      host.querySelector('[role="radiogroup"][aria-label="Frame rate"] [aria-checked="true"]')
        ?.textContent,
    ).toBe('60 fps');
  });

  it('renders a recording failure prominently and in the active locale', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        createElement(RecordTab, {
          snapshot: snapshot(recording({ error: 'disk full' })),
          refresh: () => {},
        }),
      );
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Recording failed: disk full');
  });
});
