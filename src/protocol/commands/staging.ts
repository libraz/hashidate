import { z } from 'zod';
import type { Shot } from '../../engine/types';
import { SHOT_LIMITS } from '../../engine/types';
import { cameraFrameSchema } from '../cues';
import type { Equals, Expect } from './guards';
import { placeStageSchema } from './layout';
import { correlationId, within } from './primitives';

/**
 * Where the line is delivered: the camera, the acoustic, the set, the document
 * behind the character, and where all of it sits in the broadcast frame.
 *
 * Every command here is persistent. None of them is a property of a sentence —
 * a shot is where the stream is — so each stays put until something says
 * otherwise, unlike everything under `say`.
 */

/**
 * Place the camera: a named framing, and how far to stand off it.
 *
 * The framing is the part a script cares about — how much of the character is
 * in shot — and what it means in metres is the renderer's business, since the
 * two validation avatars differ in height and in where their bones sit.
 *
 * The three offsets are what a *drag* produces, and they are stated against the
 * framing rather than in world space for the same reason: a camera position
 * measured on one avatar puts the next one's head out of frame, and a
 * quarter-turn means the same thing on both. See `Shot` in the engine.
 *
 * Every field is optional and an absent one is left alone. A framing change
 * sends one field, a drag sends two, and neither disturbs the other — which is
 * what lets the panel's preview be the place the shot is set while a script
 * goes on naming framings.
 *
 * The bounds are a guard rather than a taste: a pitch at the pole has no
 * bearing to speak of, and a zoom outside these puts the camera inside the
 * character's head or somewhere it can no longer be seen from.
 */
export const cameraCommandSchema = z.object({
  cmd: z.literal('camera'),
  id: correlationId,
  frame: cameraFrameSchema.optional(),
  /** Degrees around the framing's target. 0 is straight on. */
  yaw: within(SHOT_LIMITS.yaw).optional(),
  /** Degrees above it. Stopped short of the pole, where there is no bearing. */
  pitch: within(SHOT_LIMITS.pitch).optional(),
  /** Multiplier on the framing's distance. 1 is the framing, higher is closer. */
  zoom: within(SHOT_LIMITS.zoom).optional(),
});

/**
 * The payload is a `Shot` and nothing else, on the same footing as `say` and
 * its `TurnRequest`: the guard trips if the engine's notion of where a camera
 * can stand moves without this schema following.
 */
type _CameraPayloadIsShot = Expect<
  Equals<Omit<z.infer<typeof cameraCommandSchema>, 'cmd' | 'id'>, Shot>
>;

export type { Shot };

/**
 * Put the voice in a named acoustic space, or take it out of one.
 *
 * `id` here is the room's own id, not the correlation id, and `null` is dry.
 * The names come back in the vocabulary, like wardrobe slots and performances,
 * because what rooms exist is renderer data rather than something the wire
 * should be pinning down — an unknown one is dry rather than a rejected command.
 *
 * Persistent, like the camera and unlike everything under `say`. A room is
 * where the stream is happening; it does not end with a line.
 */
export const roomCommandSchema = z.object({
  cmd: z.literal('room'),
  id: z.string().nullable().optional(),
});

/**
 * Which room the character is *seen* in, as `room` is which one they are heard
 * in. No id renders the character against the flat background.
 *
 * The id is a bare string for the same reason `room`'s is: what backdrops exist
 * is renderer data, and an unknown one draws nothing rather than being rejected.
 *
 * ## It is not the same axis as `room`, and joining them would be wrong
 *
 * The temptation is obvious — a character in a small bedroom should sound like
 * one — and it does not survive contact with what a stream is. The set is
 * chosen for how it reads behind a face at a fixed framing; the acoustic is
 * chosen for how a voice sits in a mix. A backdrop can be swapped mid-stream
 * for a visual beat with no implication that the microphone moved, and the
 * reverb has to stay put across that or every cut is audible. Two commands, and
 * an orchestrator that wants them to agree says so twice.
 *
 * Persistent and survives an avatar swap, like the camera and the room.
 */
export const backdropCommandSchema = z.object({
  cmd: z.literal('backdrop'),
  id: z.string().nullable().optional(),
});

/**
 * Put a document up behind the character, or take it down.
 *
 * `id` here is the document's own id — the file's name without its extension —
 * and not the correlation id, on the same rule as `backdrop` and `expression`.
 * `null` takes it down. An id the renderer cannot open leaves the stream
 * running and is reported as an error rather than failing the command: the
 * document is a file an operator dropped in a directory, so a name that is a
 * minute out of date is the ordinary case rather than a bug.
 *
 * ## What documents exist is *not* in the vocabulary
 *
 * Rooms and backdrops are there because they are renderer data, decided in the
 * source it ships with. A document is whatever is in the directory right now,
 * which only the process with a filesystem can answer — so the roster comes
 * back on the snapshot, from the control server, and is re-read rather than
 * cached for the life of a page.
 *
 * ## It occupies the same place as a backdrop
 *
 * Both go behind the character, so a renderer showing a document puts the room
 * away for as long as it is up and brings it back exactly when it comes down.
 * That is a renderer's decision and is stated where it is made; here they stay
 * two commands, because a segment that goes to slides and back is one command
 * each way and neither one should have to restate the room.
 *
 * `page` is where to open it. Absent is the first page rather than "whatever
 * page we were on", which was a page of the document being replaced.
 */
export const deckCommandSchema = z.object({
  cmd: z.literal('deck'),
  id: z.string().nullable().optional(),
  page: z.number().int().min(1).optional(),
});

/**
 * Turn a page.
 *
 * Two ways to say it, because they are two different things a caller knows.
 * `page` is an absolute page, 1 based, which is what a script has. `by` is a
 * number of pages to move, which is what an operator with a hand on an arrow
 * key has — they are reacting to what is on screen and do not know the number.
 *
 * `page` wins if both are given. Neither means `by: 1`, so the bare command is
 * "next", which is the one an operator sends a hundred times in a broadcast and
 * the one a hotkey should not have to spell out.
 *
 * Past either end of the document is clamped rather than refused. A caller that
 * sends one turn too many at the end of a deck has made a very ordinary
 * mistake, and stopping on the last page is what it meant.
 */
export const slideCommandSchema = z.object({
  cmd: z.literal('slide'),
  id: correlationId,
  page: z.number().int().min(1).optional(),
  by: z.number().int().optional(),
});

/**
 * Lay out the frame: where the character stands in it, and where the document
 * behind them sits.
 *
 * ## Why this is not the camera
 *
 * A `camera` says where to stand to look at the character; this says where the
 * resulting picture goes in the frame that is broadcast. Sliding the character
 * into a corner by moving the camera would mean re-framing every line of the
 * segment and would put the gestures — which are authored against a framing —
 * somewhere they were never drawn for. Here the shot is untouched and the
 * picture of it is simply smaller and off to one side.
 *
 * ## Why both layers are one command
 *
 * They are one decision. A document that fills the frame wants the character
 * small in a corner; a document in the left two thirds wants them standing in
 * the right one. Sending those as two commands means a frame that is briefly
 * wrong between them, in the direction that is most visible — two things
 * overlapping.
 *
 * Both halves are partials that merge onto what is set, like a tuning patch.
 * Absent means "leave it", never "reset it".
 */
export const placeCommandSchema = z.object({
  cmd: z.literal('place'),
  id: correlationId,
  ...placeStageSchema.shape,
});
