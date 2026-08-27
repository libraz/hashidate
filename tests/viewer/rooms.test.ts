import { describe, expect, it } from 'vitest';
import { ROOMS, roomList } from '@/viewer/rooms';

/**
 * The table, not the acoustics.
 *
 * What a room sounds like is a judgement made by listening, and no assertion
 * here is going to catch a reverb that is too wet. What these do catch is a
 * room that cannot be built at all — a negative dimension, an absorption
 * outside the range the model accepts, a mix that would invert the dry gain —
 * because those fail silently at the far end, as a room that is simply never
 * heard.
 */

describe('the room table', () => {
  it('describes every room as a room that could exist', () => {
    for (const [id, room] of Object.entries(ROOMS)) {
      expect(room.label.en, id).not.toBe('');
      expect(room.label.ja, id).not.toBe('');
      for (const m of [room.lengthM, room.widthM, room.heightM]) {
        expect(m, id).toBeGreaterThan(0);
      }
      // Absorption is clamped to [0, 0.999] downstream, so a 1 here would be
      // silently taken as 0.999 rather than as the anechoic chamber it reads as.
      expect(room.absorption, id).toBeGreaterThan(0);
      expect(room.absorption, id).toBeLessThan(1);
    }
  });

  it('keeps every mix inside the range the equal-power split assumes', () => {
    // The dry gain is sqrt(1 - mix). Outside 0..1 that is NaN, which silences
    // the voice rather than doing anything audible enough to notice.
    for (const [id, room] of Object.entries(ROOMS)) {
      expect(room.mix, id).toBeGreaterThanOrEqual(0);
      expect(room.mix, id).toBeLessThanOrEqual(1);
    }
  });

  it('stays a room rather than becoming an effect', () => {
    // Well under half. A voice heard more as room than as voice is not a stage
    // this is for, and the number is easy to nudge past while tuning by ear.
    for (const [id, room] of Object.entries(ROOMS)) {
      expect(room.mix, id).toBeLessThan(0.5);
    }
  });

  it('offers the table to the vocabulary as ids and labels', () => {
    const listed = roomList();
    expect(listed.map((r) => r.id)).toEqual(Object.keys(ROOMS));
    for (const { id, label } of listed) {
      expect(label).toEqual(ROOMS[id as keyof typeof ROOMS].label);
    }
  });
});
