import { useSyncExternalStore } from 'react';
import { RECORD_DEFAULTS } from '@/protocol';

/** The settings a take is started with, as the operator has chosen them. */
export interface TakeSettings {
  frame: '1920x1080' | '1280x720';
  fps: '30' | '60';
  autoStop: boolean;
  lead: number;
  tail: number;
}

const DEFAULTS: TakeSettings = {
  frame: '1920x1080',
  fps: '30',
  autoStop: true,
  lead: RECORD_DEFAULTS.lead,
  tail: RECORD_DEFAULTS.tail,
};

// Module scope so the choices outlive the tab, which unmounts when another is shown.
let chosen: TakeSettings = DEFAULTS;
const listeners = new Set<() => void>();

/** The values the operator has chosen for the next take. */
export function chosenSettings(): TakeSettings {
  return chosen;
}

/** Change one or more chosen values. */
export function chooseSettings(patch: Partial<TakeSettings>): void {
  chosen = { ...chosen, ...patch };
  for (const listener of listeners) listener();
}

/** Back to the defaults. */
export function resetSettings(): void {
  chosen = DEFAULTS;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chosen settings, re-rendering the caller when they change. */
export function useChosenSettings(): TakeSettings {
  return useSyncExternalStore(subscribe, chosenSettings);
}
