/**
 * The text the core's rig answers with numbers: why an arm's constrained solver is off, the
 * joint readout's labels, and the limiter's refusal to switch back on.
 */

import {
  CALIBRATION_FRONT_ALONG_AXIS,
  CALIBRATION_PALM_ALONG_AXIS,
  CALIBRATION_WRIST_BEYOND_INVERSE,
  CALIBRATION_ZERO_AXIS,
  NO_NODE,
  OFF_NO_PALM_FRAME,
  OFF_REFUSED,
  OFF_REST_POSE_OUTSIDE_MODEL,
  OFF_REST_POSE_UNREADABLE,
  REFUSAL_CALIBRATION,
  REFUSAL_HAND_LENGTH,
  REFUSAL_NO_PARENT,
  REFUSAL_NOT_CONFORMAL,
  REFUSAL_SWEEP_RESOLUTION,
  REFUSAL_UNRESOLVED,
} from '../../core/abi/rig';
import type { Localized } from '../../i18n/locale';

/** The setter's throw when no feasible arm pose can be restored. */
export const LIMITS_REFUSED =
  'Could not restore a feasible arm pose; anatomical limits remain disabled.';

const OFF: Record<number, string> = {
  [OFF_NO_PALM_FRAME]: 'no palm frame (fingers unresolved)',
  [OFF_REST_POSE_UNREADABLE]: 'rest arm pose unreadable',
  [OFF_REST_POSE_OUTSIDE_MODEL]: 'rest arm pose outside the calibrated model',
};

/** `ArmDriver.create`'s refusals, as it words them. */
const REFUSAL: Record<number, string> = {
  [REFUSAL_UNRESOLVED]: 'arm bones, limb lengths, palm or finger clearance unresolved',
  [REFUSAL_NOT_CONFORMAL]: 'arm bones not conformally scaled',
  [REFUSAL_NO_PARENT]: 'upper arm has no parent',
  [REFUSAL_HAND_LENGTH]: 'measured hand length must be finite and positive',
  [REFUSAL_SWEEP_RESOLUTION]: 'sweep resolution must be finite and positive',
};

/** `captureArmCalibration`'s refusals, as it words them. */
const CALIBRATION: Record<number, string> = {
  [CALIBRATION_ZERO_AXIS]: 'arm calibration axis must be nonzero',
  [CALIBRATION_FRONT_ALONG_AXIS]: 'upper humeral front must not parallel its axis',
  [CALIBRATION_PALM_ALONG_AXIS]: 'hand palm normal must not parallel its axis',
  [CALIBRATION_WRIST_BEYOND_INVERSE]:
    'wrist hard ranges must stay inside a 90 degree combined bend',
};

function known(table: Record<number, string>, code: number, what: string): string {
  const text = table[code];
  if (text === undefined) throw new Error(`Rig: unknown ${what} code ${code}`);
  return text;
}

/** The reason of one SOLVER_OFF record, as `armSolverOff` words it after `<side>: `. */
export function solverOffReason(off: number, refusal: number, calibration: number): string {
  if (off !== OFF_REFUSED) return known(OFF, off, 'solver-off');
  if (refusal !== REFUSAL_CALIBRATION) return known(REFUSAL, refusal, 'refusal');
  if (calibration === NO_NODE) throw new Error('Rig: a calibration refusal without its cause');
  return known(CALIBRATION, calibration, 'calibration');
}

/** Each reading's label, in READING_IDS order, as the panel shows them. */
export const READING_LABELS: readonly Localized[] = [
  { en: 'Shoulder elevation', ja: '肩 挙上' },
  { en: 'Shoulder plane', ja: '肩 挙上面' },
  { en: 'Shoulder rotation', ja: '肩 回旋' },
  { en: 'Elbow flexion', ja: '肘 屈曲' },
  { en: 'Forearm rotation', ja: '前腕 回内外' },
  { en: 'Wrist flexion', ja: '手首 掌背屈' },
  { en: 'Wrist deviation', ja: '手首 橈尺屈' },
  { en: 'Arm inside the body', ja: '腕の身体貫通' },
  { en: 'Elbow tucked in', ja: '肘の内寄り' },
];
