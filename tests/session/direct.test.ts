import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import { same } from '@/i18n/locale';
import { buildRig } from '../helpers/scene';
import { build, type Harness } from './harness';

/**
 * The controls that are not a turn: what an orchestrator sets between lines,
 * or a control surface pokes at directly.
 */

describe('Session.point', () => {
  it('states the bearing in degrees, handing it down unconverted', () => {
    const { session, director } = build();
    const spy = vi.spyOn(director.body, 'point');
    session.point({ side: 'L', azimuth: 45, elevation: -20, extent: 0.6, finger: 'middle' });
    expect(spy).toHaveBeenCalledWith('L', {
      azimuth: 45,
      elevation: -20,
      extent: 0.6,
      finger: 'middle',
    });
  });

  it('defaults to the right index finger straight ahead', () => {
    const { session, director } = build();
    const spy = vi.spyOn(director.body, 'point');
    session.point();
    expect(spy).toHaveBeenCalledWith('R', {
      azimuth: 0,
      elevation: 0,
      extent: 0.8,
      finger: 'index',
    });
  });

  it('lifts the arm for 90 degrees of elevation and not for 90 radians worth', () => {
    const handHeight = (elevation: number): number => {
      const h = build();
      h.session.point({ side: 'R', elevation });
      h.step(90);
      const hand = h.director.p.bones['hand.R'];
      if (!hand) throw new Error('the synthetic rig resolved no right hand');
      return hand.getWorldPosition(new THREE.Vector3()).y;
    };
    // Read as radians, 90 would be a bearing nowhere near shoulder height, and
    // 1.5708 would be the raised one. The degrees reading is the opposite.
    expect(handHeight(90)).toBeGreaterThan(handHeight(90 * (Math.PI / 180)) + 0.05);
  });

  it('runs as a sustained pose the state reports by name', () => {
    const { session, director, step } = build();
    session.point({ side: 'R', azimuth: 30 });
    step(2);
    expect(director.body.gesture?.id).toBe('point.R');
    expect(session.state().gesture).toBe('point.R');
  });
});

describe('direct control between turns', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = build({ wardrobe: true });
  });

  it('wear() dresses a slot and reports that it did', () => {
    expect(harness.session.wear({ slot: 'top', item: 'shirt' })).toBe(true);
    expect(harness.session.state().wardrobe).toEqual({ top: 'shirt' });
  });

  it('wear() applies a whole preset', () => {
    harness.session.wear({ slot: 'top', item: 'shirt' });
    expect(harness.session.wear({ preset: 'bare' })).toBe(true);
    expect(harness.session.state().wardrobe).toEqual({ top: null });
  });

  it('wear() with neither slot nor preset is a no-op rather than an error', () => {
    expect(harness.session.wear({})).toBe(false);
  });

  it('wear() returns false for a session with no wardrobe at all', () => {
    const bare = build();
    expect(bare.session.wear({ slot: 'top', item: 'shirt' })).toBe(false);
  });

  it('setCamera forwards the shot to the viewer callback', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const camera = vi.fn();
    const session = new Session(director, { camera });
    session.setCamera({ frame: 'face' });
    expect(camera).toHaveBeenCalledWith({ frame: 'face' });
  });

  it('setCamera passes an offset through without a framing', () => {
    // What a drag on the panel's preview sends: two angles and nothing else.
    // An absent framing means "leave it", which is the renderer's business.
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const camera = vi.fn();
    new Session(director, { camera }).setCamera({ yaw: 18, zoom: 1.4 });
    expect(camera).toHaveBeenCalledWith({ yaw: 18, zoom: 1.4 });
  });

  it('setCamera is a no-op when no viewer is attached', () => {
    expect(() => harness.session.setCamera({ frame: 'full' })).not.toThrow();
  });

  it('setBackdrop forwards the room to the scenery, null included', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const setBackdrop = vi.fn();
    const session = new Session(director, { scenery: { backdrops: [], setBackdrop } });
    session.setBackdrop('night');
    expect(setBackdrop).toHaveBeenCalledWith('night');
    // Null is the flat background and has to reach the renderer as itself. A
    // default applied here would make "take the room away" unsayable.
    session.setBackdrop(null);
    expect(setBackdrop).toHaveBeenLastCalledWith(null);
  });

  it('setBackdrop is a no-op on a renderer with no backdrops', () => {
    expect(() => harness.session.setBackdrop('night')).not.toThrow();
  });

  // The whole reason staging can ride on a turn: a caller can describe the
  // fourth line's shot while the first line is still being said, and the shot
  // still lands on the fourth line. Queued is not applied.
  it('applies a turn staging when the turn starts, not when it is queued', () => {
    const camera = vi.fn();
    const setBackdrop = vi.fn();
    const { session, step, runUntil } = build({
      camera,
      scenery: { backdrops: [], setBackdrop },
    });

    session.say({ text: 'いち', stage: { camera: 'face' } });
    session.say({ text: 'に', stage: { camera: 'full', backdrop: 'night' } });
    // Both are in the queue and neither has begun, so nothing has moved.
    expect(camera).not.toHaveBeenCalled();
    expect(setBackdrop).not.toHaveBeenCalled();

    runUntil(() => session.turn?.text === 'いち');
    expect(camera).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenLastCalledWith({ frame: 'face' });
    // The second line's backdrop is still waiting for the second line.
    expect(setBackdrop).not.toHaveBeenCalled();

    runUntil(() => session.turn?.text === 'に');
    expect(camera).toHaveBeenLastCalledWith({ frame: 'full' });
    expect(setBackdrop).toHaveBeenCalledWith('night');
    step(1);
  });

  // Absent and null are different, and the engine is where that survives or is
  // lost: `?? null` here would empty an axis the caller never mentioned.
  it('leaves a staging axis alone when the turn omits it, and empties it on null', () => {
    const camera = vi.fn();
    const setBackdrop = vi.fn();
    const { session, runUntil } = build({
      camera,
      scenery: { backdrops: [], setBackdrop },
    });

    session.say({ text: 'いち', stage: { camera: 'bust', backdrop: 'night' } });
    runUntil(() => session.turn?.text === 'いち');
    expect(setBackdrop).toHaveBeenLastCalledWith('night');

    // No backdrop key at all: the night stays up and the renderer is not told
    // anything about it a second time.
    session.say({ text: 'に', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'に');
    expect(setBackdrop).toHaveBeenCalledTimes(1);

    // An explicit null is the flat background, and has to reach the renderer.
    session.say({ text: 'さん', stage: { backdrop: null } });
    runUntil(() => session.turn?.text === 'さん');
    expect(setBackdrop).toHaveBeenLastCalledWith(null);
  });

  it('says a line with no staging without touching the shot', () => {
    const camera = vi.fn();
    const { session, runUntil } = build({ camera });
    session.say({ text: 'いち' });
    runUntil(() => session.turn?.text === 'いち');
    expect(camera).not.toHaveBeenCalled();
  });

  it('carries the staging of a turn edited in place through the queue', () => {
    const camera = vi.fn();
    const { session, runUntil } = build({ camera });
    session.say({ text: 'いち' });
    session.say({ id: 'second', text: 'に', stage: { camera: 'face' } });
    // Same id and same words, so the take is kept — and the shot has to be
    // updated with everything else that is applied at `start`.
    session.replaceQueue([{ id: 'second', text: 'に', stage: { camera: 'full' } }]);
    runUntil(() => session.turn?.text === 'に');
    expect(camera).toHaveBeenLastCalledWith({ frame: 'full' });
  });

  it('reports an empty backdrop list rather than omitting it', () => {
    // The empty list is the tell that this renderer has no rooms at all, which
    // is how a caller distinguishes "none available" from "none selected"
    // without sending a command and watching for an effect.
    expect(harness.session.vocabulary().backdrops).toEqual([]);
  });

  it('reports the backdrops the scenery advertises', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const backdrops = [{ id: 'dusk', label: same('夕暮れ') }];
    const session = new Session(director, {
      scenery: { backdrops, setBackdrop: vi.fn() },
    });
    expect(session.vocabulary().backdrops).toEqual(backdrops);
  });

  it('lookAt is reported back through state', () => {
    harness.session.lookAt(0.25);
    expect(harness.session.state().lookAt).toBe(0.25);
  });

  it('resetExpression clears the pick, the overlays and the mood', () => {
    harness.session.setExpression('F_DOYA');
    harness.session.setOverlay('FX_TEARS', 1);
    harness.session.setEmotion({ anger: 1 });
    harness.session.resetExpression();
    const state = harness.session.state();
    expect(state.pickedExpression).toBeNull();
    expect(state.overlays).toEqual({});
    expect(state.emotion).toEqual({ neutral: 1 });
  });
});
