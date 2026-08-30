import type { Localized } from '../../i18n/locale';

/**
 * The body being depicted, rather than any one avatar's copy of it.
 *
 * Joint ranges are engine data — every humanoid has the same shoulder — so an
 * avatar only appears here when it overrides the table wholesale.
 */

/**
 * One degree of freedom, in radians.
 *
 * Two bands rather than one bound: `free` is the range daily movement actually
 * uses and costs nothing, `max` is the hard stop. The gap between them is the
 * strained band a solver may spend at a rising cost. See `anatomy/joints.ts`.
 */
export interface JointDof {
  label: Localized;
  free: [number, number];
  max: [number, number];
}

/** Shoulder elevation ceiling samples: `[planeDegrees, freeDegrees, maxDegrees]`. */
export type ElevationRow = [number, number, number];

export interface JointSpec {
  label: Localized;
  dofs: Record<string, JointDof>;
  /** Only the shoulder has one: how far it lifts depends on which way it lifts. */
  elevation?: ElevationRow[];
}

/**
 * The joint table.
 *
 * Engine data, not avatar data — it describes the body being depicted, so it is
 * the same for every humanoid. An avatar that is deliberately not human
 * overrides it through `AvatarDescriptor.anatomy`.
 */
export interface JointTable {
  shoulder: JointSpec & { elevation: ElevationRow[] };
  elbow: JointSpec;
  wrist: JointSpec;
  finger: JointSpec;
  thumb: JointSpec;
  neck: JointSpec;
  spine: JointSpec;
}

export type StrainZone = 'natural' | 'strained' | 'limit';

/** One row of the joint readout. */
export interface JointReading {
  id: string;
  label: Localized;
  /** Degrees, or a percentage where `unit` says so. */
  deg: number;
  unit?: string;
  strain: number;
  zone: StrainZone;
  range: [number, number];
  /**
   * False for a quantity that exists but is not determined by the current pose
   * — the plane of a hanging arm, the rotation of a straight one. Showing a
   * zone for those would report noise as a judgement.
   */
  measured: boolean;
}
