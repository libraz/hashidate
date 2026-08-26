import type { GestureVariation } from '../types';

/**
 * The curves the idle is built from.
 *
 * Pure functions of a phase or an amplitude — no state, no rig, nothing from
 * three. Most of what keeps an idle from reading as machine-driven is the
 * *shape* of these, and a shape can be checked on its own.
 */

export const smoothstep = (x: number): number => x * x * (3 - 2 * x);

/**
 * Breath shape. Inhale is markedly quicker than exhale — roughly 2:3 — and a
 * symmetric sine is one of the things that makes an idle read as mechanical
 * without the viewer being able to say why.
 */
const INHALE = 0.38;
export const breathCurve = (p: number): number =>
  p < INHALE
    ? 0.5 - 0.5 * Math.cos((p / INHALE) * Math.PI)
    : 0.5 + 0.5 * Math.cos(((p - INHALE) / (1 - INHALE)) * Math.PI);

/**
 * Flattens a sine toward a trapezoid. Weight settles onto one foot and rests
 * there before transferring; a pure sine never rests, which reads as swaying
 * rather than as standing.
 */
const SETTLE = Math.tanh(2.1);
export const settle = (x: number): number => Math.tanh(x * 2.1) / SETTLE;

/**
 * Soft limit for the eye channels: proportional near centre, asymptotic at the
 * bound. The eye range on a painted eye is small enough that a hard clamp is
 * reached constantly, and a clamped eye sits pinned against the boundary for
 * the whole of a large glance — which reads as an eye that has jammed. This
 * compresses instead, so the eye keeps moving in the right direction and simply
 * never arrives anywhere that shows sclera.
 */
export const saturate = (x: number, limit: number): number => limit * Math.tanh(x / limit);

/** Stands in for a playing gesture's variation on the frames there is none. */
export const DEFAULT_VARIATION: GestureVariation = { rate: 1, scale: 1, side: 1 };
