import { describe, expect, it } from 'vitest';
import { parseCommand } from '@/protocol';

/**
 * The face: the mood, the drawn expression, the effects over both.
 */

describe('emotion', () => {
  it('accepts the weights under vec', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 0.6 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 0.6 },
    });
  });

  it('accepts the same weights under emotion', () => {
    expect(parseCommand({ cmd: 'emotion', emotion: { joy: 0.6 } })).toEqual({
      cmd: 'emotion',
      emotion: { joy: 0.6 },
    });
  });

  it('keeps both spellings when both are given, so the applier can prefer vec', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 1 }, emotion: { anger: 1 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 1 },
      emotion: { anger: 1 },
    });
  });

  it('accepts every canonical emotion name', () => {
    const names = ['neutral', 'joy', 'anger', 'sadness', 'surprise', 'relaxed', 'thinking', 'shy'];
    for (const name of names) {
      expect(parseCommand({ cmd: 'emotion', vec: { [name]: 1 } })).not.toBeNull();
    }
  });

  it('does not bound the weights, because the consuming layers normalise', () => {
    expect(parseCommand({ cmd: 'emotion', vec: { joy: 4, anger: -1 } })).toEqual({
      cmd: 'emotion',
      vec: { joy: 4, anger: -1 },
    });
  });
});

describe('expression', () => {
  it('parses null, which hands the face back to the emotion vector', () => {
    expect(parseCommand({ cmd: 'expression', id: null })).toEqual({
      cmd: 'expression',
      id: null,
    });
  });

  it('distinguishes an explicit null from an absent id only by presence', () => {
    const explicit = parseCommand({ cmd: 'expression', id: null }) as { id?: string | null };
    const absent = parseCommand({ cmd: 'expression' }) as { id?: string | null };
    expect(explicit.id).toBeNull();
    expect('id' in absent).toBe(false);
  });

  it('spends id on the expression rather than on correlation', () => {
    expect(parseCommand({ cmd: 'expression', id: 'F_DOYA' })).toEqual({
      cmd: 'expression',
      id: 'F_DOYA',
    });
  });
});

describe('overlay', () => {
  it('accepts a partial weight', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'FX_TEARS', weight: 0.25 })).toEqual({
      cmd: 'overlay',
      id: 'FX_TEARS',
      weight: 0.25,
    });
  });

  it('accepts on: false as the short way of saying weight 0', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'FX_TEARS', on: false })).toEqual({
      cmd: 'overlay',
      id: 'FX_TEARS',
      on: false,
    });
  });

  it('accepts both bounds of the weight range', () => {
    expect(parseCommand({ cmd: 'overlay', id: 'x', weight: 0 })).not.toBeNull();
    expect(parseCommand({ cmd: 'overlay', id: 'x', weight: 1 })).not.toBeNull();
  });
});
