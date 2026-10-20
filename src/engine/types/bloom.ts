/** The full, resolved state of the renderer's bloom pass. */
export interface BloomSettings {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}

/** The knobs a command or control surface may change at once. */
export type BloomPatch = Partial<BloomSettings>;

/** The initial look is subtle and stays off until an operator asks for it. */
export const BLOOM_DEFAULTS = {
  enabled: false,
  strength: 0.2,
  radius: 0.4,
  threshold: 0.85,
} as const satisfies BloomSettings;

/** Shared bounds for the wire command and the controls that edit it. */
export const BLOOM_RANGES = {
  strength: { min: 0, max: 3 },
  radius: { min: 0, max: 1 },
  threshold: { min: 0, max: 2 },
} as const;
