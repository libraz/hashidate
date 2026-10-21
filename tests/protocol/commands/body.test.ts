import { describe, expect, it } from 'vitest';
import { parseCommand } from '@/protocol';

/**
 * What the body does, and the two aims that are continuous.
 */

describe('the hand a movement uses', () => {
  it('is left out of an ordinary call, which is what keeps it varying', () => {
    expect(parseCommand({ cmd: 'gesture', id: 'peace' })).toEqual({ cmd: 'gesture', id: 'peace' });
  });

  it('takes the same two names everywhere a side is written', () => {
    for (const cmd of ['gesture', 'perform'] as const) {
      for (const side of ['L', 'R'] as const) {
        expect(parseCommand({ cmd, id: 'peace', side })).toEqual({ cmd, id: 'peace', side });
      }
    }
  });

  it('rejects a spelling the engine has no hand for', () => {
    expect(parseCommand({ cmd: 'gesture', id: 'peace', side: 'left' })).toBeNull();
    expect(parseCommand({ cmd: 'gesture', id: 'peace', side: 'l' })).toBeNull();
    expect(parseCommand({ cmd: 'say', text: 'やあ', gesture: 'wave', side: 'both' })).toBeNull();
  });

  it('rides on a line, which is how a script states one', () => {
    expect(parseCommand({ cmd: 'say', text: 'やあ', perform: 'hello', side: 'R' })).toEqual({
      cmd: 'say',
      text: 'やあ',
      perform: 'hello',
      side: 'R',
    });
  });
});

describe('point angles', () => {
  it('accepts a bearing past the anatomical range, so strain can report the cost', () => {
    // Rejecting these would take away the only way a caller can tell an aim the
    // arm met from one it could only approximate.
    expect(parseCommand({ cmd: 'point', azimuth: 400, elevation: -900 })).toEqual({
      cmd: 'point',
      azimuth: 400,
      elevation: -900,
    });
  });

  it('accepts an extent outside the range the solver clamps to', () => {
    expect(parseCommand({ cmd: 'point', azimuth: 10, extent: 12 })).toEqual({
      cmd: 'point',
      azimuth: 10,
      extent: 12,
    });
  });

  it('accepts the advertised bounds themselves', () => {
    for (const azimuth of [-120, 120]) {
      for (const elevation of [-70, 110]) {
        expect(parseCommand({ cmd: 'point', azimuth, elevation })).not.toBeNull();
      }
    }
  });
});

describe('the idle choices the server sends', () => {
  it('carry a performance and the hand drawn for it', () => {
    expect(parseCommand({ cmd: 'idleAct', act: 'peace', side: 'R' })).toEqual({
      cmd: 'idleAct',
      act: 'peace',
      side: 'R',
    });
  });

  it('take a face draw in [0, 1), or null to take the face down', () => {
    expect(parseCommand({ cmd: 'idleFace', draw: 0 })).toEqual({ cmd: 'idleFace', draw: 0 });
    expect(parseCommand({ cmd: 'idleFace', draw: null })).toEqual({ cmd: 'idleFace', draw: null });
    for (const draw of [1, -0.1, 2, undefined]) {
      expect(parseCommand({ cmd: 'idleFace', draw })).toBeNull();
    }
  });

  it('refuse an act with no performance or a hand the engine has none of', () => {
    expect(parseCommand({ cmd: 'idleAct' })).toBeNull();
    expect(parseCommand({ cmd: 'idleAct', act: 'peace', side: 'left' })).toBeNull();
  });
});
