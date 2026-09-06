import { getLocale, type Localized, pick } from '../i18n/locale';
import { fail } from './client';

/**
 * What this client prints.
 *
 * Two functions, because there are only two kinds of output: the JSON a command
 * came back with, and a label that arrived in both languages.
 */

export interface ShowOptions {
  /** Keep printing caller-owned follow-up output before exiting on failure. */
  exitOnError?: boolean;
}

export function show(value: unknown, { exitOnError = true }: ShowOptions = {}): string | null {
  console.log(JSON.stringify(value, null, 2));
  const error = commandError(value);
  if (error !== null && exitOnError) fail(error);
  return error;
}

/** A command response with no delivery is a failed CLI invocation. */
function commandError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.error === 'string') return response.error;
  return response.ok === false ? 'control command was not delivered' : null;
}

/**
 * A two-language label, printed in one of them.
 *
 * The wire carries both. This is a terminal, and everything else it prints is
 * English, so it takes the locale in force — which falls back to English when
 * nothing has said otherwise.
 */
export const localized = (text: Localized): string => pick(text, getLocale());
