import { describe, expect, it } from 'vitest';
import {
  avatarStatusSchema,
  type EmotionVector,
  type FingerName,
  type Placement,
  placementSchema,
  placeStageSchema,
  recordingSchema,
  rendererIdSchema,
  type Side,
  type SlidePlacement,
  type Staging,
  stageSchema,
} from '@/protocol';

describe('protocol public barrel', () => {
  it('exports stage and placement schemas at runtime', () => {
    const placement = {
      avatar: { anchor: 'bottom-right', width: 0.4 },
      slide: { fit: 'contain' },
    };
    expect(placeStageSchema.parse(placement)).toEqual(placement);
    expect(stageSchema.parse({ camera: 'bust', place: placement })).toEqual({
      camera: 'bust',
      place: placement,
    });
  });

  it('exports recording, avatar status and renderer identity schemas', () => {
    expect(avatarStatusSchema.parse({ phase: 'failed', error: 'load failed' })).toEqual({
      phase: 'failed',
      error: 'load failed',
    });
    expect(rendererIdSchema.parse('stage-window-1')).toBe('stage-window-1');
    expect(
      recordingSchema.parse({
        session: 'r1',
        file: '/tmp/take.webm',
        mime: null,
        since: 1,
        bytes: 0,
        autoStop: true,
        width: 320,
        height: 180,
        fps: 30,
      }).error,
    ).toBeNull();
  });

  it('exports the guard-verified related types without a parallel shape', () => {
    const staging: Staging = { camera: 'full', room: null };
    const avatar: Placement = { width: 0.5 };
    const slide: SlidePlacement = { ...avatar, fit: 'cover' };
    const side: Side = 'L';
    const finger: FingerName = 'index';
    const emotion: EmotionVector = { joy: 1 };
    expect([staging, avatar, slide, side, finger, emotion]).toHaveLength(6);
  });

  it('keeps placement validation shared by place and stage schemas', () => {
    expect(placementSchema.safeParse({ width: 0 }).success).toBe(false);
    expect(stageSchema.safeParse({ place: { avatar: { width: 0 } } }).success).toBe(false);
  });
});
