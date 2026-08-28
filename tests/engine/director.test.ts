import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import type { PresetSpec } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

/**
 * Two drawn faces that differ only in what they do to the eye.
 *
 * `F_SWAP` carries the whole of the parking travel the avatar's own `H_IRIS`
 * supplies, which is what a face that replaces the iris rather than reshaping it
 * looks like to the measurement. `F_PLAIN` carries a tenth of it, which is what
 * every ordinary face measures at.
 */
const HIDE_GROUP = 'Hide';
const FACE_GROUP = 'Face';
const DELTAS = { H_IRIS: 4e-3, F_SWAP: 4e-3, F_PLAIN: 4e-4 };

function build(presets: Partial<PresetSpec> = {}) {
  const rig = buildRig({
    groups: [
      [HIDE_GROUP, ['H_IRIS']],
      [FACE_GROUP, ['F_SWAP', 'F_PLAIN']],
    ],
    deltas: DELTAS,
  });
  const profile = buildProfile(rig.root, {
    ...rig.descriptor,
    presets: {
      group: FACE_GROUP,
      hideGroup: HIDE_GROUP,
      emotion: { surprise: 'F_SWAP', joy: 'F_PLAIN' },
      ...presets,
    },
  });
  const director = new Director(profile);

  const face = rig.meshes.get('Face');
  if (!face) throw new Error('the synthetic rig built no face');
  /** What the face channel actually wrote for a shape this frame. */
  const weight = (id: string): number => {
    const index = face.morphTargetDictionary?.[id];
    return index === undefined ? 0 : (face.morphTargetInfluences?.[index] ?? 0);
  };

  const step = (frames: number): void => {
    for (let i = 0; i < frames; i++) director.update(DT);
  };
  /** Run until the emotion vector has arrived where it was pointed. */
  const settle = (name: 'joy' | 'surprise', to: number): void => {
    for (let i = 0; i < 600 && Math.abs((director.emotion[name] ?? 0) - to) > 1e-4; i++) step(1);
  };

  return { director, weight, step, settle };
}

describe('Director / an authored face that replaces the eye', () => {
  it('measures the drawings apart rather than being told which is which', () => {
    const { director } = build();
    const swap = director.presetById.get('F_SWAP');
    const plain = director.presetById.get('F_PLAIN');
    expect(swap?.swap).toBeCloseTo(1, 6);
    expect(plain?.swap).toBeCloseTo(0.1, 6);
  });

  it('draws it whole from an emotion that is only just dominant', () => {
    // The failure this exists to prevent: at four tenths the drawing is four
    // tenths of the way through parking the default iris, so the iris sits
    // half out of its opening on top of the new eye and the eyeball reads as
    // broken. There is no such thing as four tenths of this face.
    const { director, weight, settle } = build();
    director.setEmotion({ surprise: 0.4 });
    settle('surprise', 0.4);
    expect(weight('F_SWAP')).toBe(1);
  });

  it('leaves a face that only reshapes scaled by how strongly the emotion is felt', () => {
    const { director, weight, settle } = build();
    director.setEmotion({ joy: 0.4 });
    settle('joy', 0.4);
    expect(weight('F_PLAIN')).toBeGreaterThan(0.3);
    expect(weight('F_PLAIN')).toBeLessThan(0.45);
  });

  it('never holds one at a fraction on the way in', () => {
    const { director, weight, step } = build();
    director.setEmotion({ surprise: 1 });
    for (let i = 0; i < 240; i++) {
      step(1);
      const w = weight('F_SWAP');
      expect(w === 0 || w === 1).toBe(true);
    }
  });

  it('drops one in a frame rather than fading it out through halves', () => {
    const { director, weight, step, settle } = build();
    director.setEmotion({ surprise: 0.9 });
    settle('surprise', 0.9);
    expect(weight('F_SWAP')).toBe(1);

    director.setEmotion({ neutral: 1 });
    // The emotion decays over several frames; the drawing goes the moment it
    // stops being asked for, and is never written at anything in between.
    for (let i = 0; i < 240; i++) {
      step(1);
      const w = weight('F_SWAP');
      expect(w === 0 || w === 1).toBe(true);
    }
    expect(weight('F_SWAP')).toBe(0);
  });

  it('still fades a face that merely reshapes, so an ordinary one is unchanged', () => {
    const { director, weight, step, settle } = build();
    director.setEmotion({ joy: 0.9 });
    settle('joy', 0.9);
    director.setEmotion({ neutral: 1 });

    const seen: number[] = [];
    for (let i = 0; i < 240; i++) {
      step(1);
      seen.push(weight('F_PLAIN'));
    }
    expect(seen.some((w) => w > 0.02 && w < 0.85)).toBe(true);
    expect(seen.at(-1)).toBe(0);
  });

  it('measures nothing when the avatar names no group of parking shapes', () => {
    // Without the declaration every drawing is an ordinary one, which is the
    // right answer for an avatar whose faces do not park anything.
    const { director } = build({ hideGroup: undefined });
    for (const preset of director.presets) expect(preset.swap).toBe(0);
  });
});

describe('Director / the composed expression underneath', () => {
  it('yields the whole face to a drawing that replaced the eye', () => {
    const { director, settle } = build();
    director.setEmotion({ surprise: 0.4 });
    settle('surprise', 0.4);
    // Nothing muscle-level is left over the drawing: the artist placed the
    // brows and the lids, and a composed 60% on top would smear them.
    const face = director.p.morphTargets.get('browInnerUp')?.[0];
    if (!face) throw new Error('the synthetic rig carries no ARKit shapes');
    expect(face.mesh.morphTargetInfluences?.[face.index]).toBe(0);
  });
});

describe('Director / authored mouth opening while speaking', () => {
  function buildMouth() {
    const rig = buildRig({
      groups: [[FACE_GROUP, ['F_OPEN']]],
      deltas: { mouthClose: 4e-3, F_OPEN: -2e-3 },
    });
    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      presets: { group: FACE_GROUP },
    });
    const director = new Director(profile);
    const face = rig.meshes.get('Face');
    if (!face) throw new Error('the synthetic rig built no face');
    const weight = (id: string): number => {
      const index = face.morphTargetDictionary?.[id];
      return index === undefined ? 0 : (face.morphTargetInfluences?.[index] ?? 0);
    };
    const step = (frames: number): void => {
      for (let i = 0; i < frames; i++) director.update(DT);
    };
    return { director, weight, step };
  }

  it('keeps the authored open face at rest and adds close plus viseme while speaking', () => {
    const { director, weight, step } = buildMouth();
    director.setExpression('F_OPEN');
    step(120);
    expect(weight('F_OPEN')).toBeCloseTo(1, 3);
    expect(weight('mouthClose')).toBe(0);

    director.speak('あいうえお');
    step(2);
    expect(weight('F_OPEN')).toBeCloseTo(1, 3);
    expect(weight('mouthClose')).toBeGreaterThan(0);
    expect(weight('vrc.v_aa')).toBeGreaterThan(0);

    director.mouth.stop();
    step(1);
    expect(weight('F_OPEN')).toBeCloseTo(1, 3);
    expect(weight('mouthClose')).toBeGreaterThan(0);
    step(120);
    expect(weight('mouthClose')).toBeLessThan(0.001);
  });

  it('leaves the authored face unchanged when mouthClose is unavailable', () => {
    const rig = buildRig({ arkit: false, groups: [[FACE_GROUP, ['F_OPEN']]] });
    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      presets: { group: FACE_GROUP },
    });
    const director = new Director(profile);
    const face = rig.meshes.get('Face');
    if (!face) throw new Error('the synthetic rig built no face');
    director.setExpression('F_OPEN');
    director.speak('あ');
    for (let i = 0; i < 2; i++) director.update(DT);
    const close = face.morphTargetDictionary?.mouthClose;
    expect(close).toBeUndefined();
  });
});

describe('buildRig / stated deltas', () => {
  it('writes the delta a shape was given and the default for the rest', () => {
    const rig = buildRig({ groups: [[FACE_GROUP, ['F_SWAP', 'F_PLAIN']]], deltas: DELTAS });
    const face = rig.meshes.get('Face');
    const attrs = face?.geometry.morphAttributes.position;
    const dict = face?.morphTargetDictionary;
    if (!(attrs && dict)) throw new Error('the synthetic face carries no morph attributes');
    const dy = (id: string): number => attrs[dict[id]].getY(0);
    expect(dy('F_SWAP')).toBeCloseTo(DELTAS.F_SWAP, 9);
    expect(dy('F_PLAIN')).toBeCloseTo(DELTAS.F_PLAIN, 9);
    expect(dy('blink')).toBeGreaterThan(0);
    expect(dy('blink')).not.toBeCloseTo(DELTAS.F_SWAP, 9);
  });
});
