import { init, synthesizeRir } from '@libraz/libsonare';
import type { LabelledId } from '@/engine/types';
import type { Localized } from '@/i18n/locale';

/**
 * The spaces the voice can be heard in.
 *
 * A synthesised line arrives with no room on it at all — deliberately, since the
 * one the reference recordings carried is removed before the model ever sees
 * them. That is the right raw material and the wrong thing to broadcast: a voice
 * with no early reflections reads as a voice in a vacuum, which is a thing
 * listeners notice without being able to say what it is.
 *
 * So a room is put back, but a chosen one. Each entry below is a physical
 * description — a box, its absorption, where the speaker and the listener stand
 * in it — and the impulse response is derived from that rather than dialled in
 * as a decay time. Naming a room by its size and its walls is the part worth
 * writing down; a reverb time is what comes out.
 *
 * None of this touches the mouth. The envelope that drives it is measured off
 * the dry take before any of this is connected, so the room rings on after the
 * mouth has closed, which is what a room does.
 */

export interface Room {
  label: Localized;
  /** Metres. The listener stands `LISTENER_OFFSET_M` in front of the speaker. */
  lengthM: number;
  widthM: number;
  heightM: number;
  /**
   * Uniform wall absorption, 0..1. This is the dial that decides the reverb
   * time; the geometry decides its character.
   */
  absorption: number;
  /**
   * How much of the room is in the mix, 0..1, against the dry voice.
   *
   * A starting point rather than a measurement — how much room is too much is a
   * judgement made by listening on the stream's own output chain, not something
   * that can be derived from the impulse response. Bigger rooms carry less of
   * it here because their tails are long enough to sit on top of the next line.
   */
  mix: number;
}

/**
 * Where the two of them stand.
 *
 * Close, and both off the walls: a speaker addressing a microphone from arm's
 * length, which is the only arrangement this is ever used for. Moving the
 * listener back is how a room gets wetter in reality, but it is not offered as
 * a dial because `mix` says the same thing more directly.
 */
const LISTENER_OFFSET_M = 0.7;
const HEAD_HEIGHT_M = 1.4;

/**
 * Fixed, so a room sounds the same on Tuesday as it did on Monday.
 *
 * The late tail is built from a noise process and a stream that regenerated it
 * per session would drift in character without anything having been changed.
 */
const SEED = 7;

/**
 * The rooms, measured. Reverb times are what the model produced at these
 * dimensions, quoted so the next person can tell whether a change moved
 * anything: RT60 rises about 60% for every 0.1 taken off the absorption.
 */
export const ROOMS: Record<string, Room> = {
  /** RT60 0.08 s. A treated box — not silence, but nothing you would call a room. */
  booth: {
    label: { en: 'Booth', ja: 'ブース' },
    lengthM: 3.0,
    widthM: 2.4,
    heightM: 2.4,
    absorption: 0.6,
    mix: 0.16,
  },
  /** RT60 0.27 s. An ordinary room in an ordinary building, which is the default. */
  room: {
    label: { en: 'Room', ja: '部屋' },
    lengthM: 5.5,
    widthM: 4.0,
    heightM: 2.5,
    absorption: 0.3,
    mix: 0.22,
  },
  /** RT60 0.58 s. Larger and harder — a live room rather than a treated one. */
  studio: {
    label: { en: 'Studio', ja: 'スタジオ' },
    lengthM: 8.0,
    widthM: 6.0,
    heightM: 3.2,
    absorption: 0.2,
    mix: 0.26,
  },
  /** RT60 2.17 s. Somewhere to say something that needs the space. */
  hall: {
    label: { en: 'Hall', ja: 'ホール' },
    lengthM: 26.0,
    widthM: 18.0,
    heightM: 11.0,
    absorption: 0.15,
    mix: 0.3,
  },
};

export type RoomId = keyof typeof ROOMS;

/** The room ids and their labels, for the vocabulary. */
export const roomList = (): LabelledId[] =>
  Object.entries(ROOMS).map(([id, room]) => ({ id, label: room.label }));

/**
 * Build a room's impulse response, ready for a `ConvolverNode`.
 *
 * The WASM is loaded on the first call and not before. A machine with no speech
 * sidecar never reaches this, and a four-megabyte download for a feature that
 * will not be used is worth avoiding even over loopback.
 *
 * The convolver is left with `normalize` at its default, so the equal-power
 * scaling the Web Audio API applies is what keeps `mix` meaning the same amount
 * of room across four impulse responses of very different lengths.
 */
export async function buildImpulse(ctx: BaseAudioContext, room: Room): Promise<AudioBuffer> {
  await init();
  const { rir, sampleRate } = synthesizeRir({
    sampleRate: ctx.sampleRate,
    lengthM: room.lengthM,
    widthM: room.widthM,
    heightM: room.heightM,
    absorption: room.absorption,
    seed: SEED,
    sourceX: room.lengthM / 2,
    sourceY: room.widthM / 2,
    sourceZ: HEAD_HEIGHT_M,
    listenerX: room.lengthM / 2,
    listenerY: room.widthM / 2 - LISTENER_OFFSET_M,
    listenerZ: HEAD_HEIGHT_M,
  });

  const buffer = ctx.createBuffer(1, rir.length, sampleRate);
  // `set` and not `copyToChannel`, which insists on a `Float32Array<ArrayBuffer>`
  // where the WASM heap hands back an `ArrayBufferLike`. This writes into the
  // buffer's own storage rather than reallocating a megabyte to satisfy a type.
  buffer.getChannelData(0).set(rir);
  return buffer;
}
