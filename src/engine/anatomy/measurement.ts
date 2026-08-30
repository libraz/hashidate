/**
 * The quantities anatomy has an opinion about, and what each one costs.
 *
 * Two flat records rather than one, because they are filled at different times
 * and by different things: `ArmAnatomy.measure` writes the first from a pose,
 * and `cost.ts` writes the second from the first. Both are handed out as shared
 * objects — the elbow search evaluates a couple of dozen candidates per arm per
 * frame, and allocating a pair for each would be the dominant cost.
 */

/**
 * One arm's pose, in the quantities anatomy has an opinion about. Radians,
 * except `torso` and `inboard`, which are fractions.
 */
export interface ArmMeasurement {
  elevation: number;
  plane: number;
  rotation: number;
  elbow: number;
  forearm: number;
  wristFlex: number;
  wristDev: number;
  torso: number;
  inboard: number;
  /** How much the humeral rotation reading can be trusted, 0..1. */
  rotationRead: number;
}

/** Strain per degree of freedom, 0 inside the free band and 1 at the stop. */
export interface ArmStrain {
  elevation: number;
  rotation: number;
  elbow: number;
  forearm: number;
  wristFlex: number;
  wristDev: number;
  torso: number;
}
