import type { ZodType } from 'zod';
import { type ControlClient, DEFAULT_BASE, fail } from './client';

/**
 * Reading a command line, and turning what it says into a command.
 *
 * `parseArgs` is run once per subcommand, with that subcommand's own options,
 * so anything global or anything it has no form for has to be dealt with before
 * it sees the argv. That is what the shims here are: each one exists because
 * `parseArgs` reads something the way a terminal does not mean it.
 */

/** One subcommand. Every entry in the table `main` dispatches on is one of these. */
export type Handler = (client: ControlClient, args: string[]) => Promise<void>;

export const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

// --- argv shims -------------------------------------------------------------

/**
 * `--base` overrides the server, and may appear anywhere on the line.
 *
 * Taken out before the subcommand is picked, because `parseArgs` is run once
 * per subcommand with that subcommand's own options and knows nothing global.
 */
export function takeBase(argv: string[]): { base: string; rest: string[] } {
  let base = DEFAULT_BASE;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--base') {
      const value = argv[i + 1];
      if (value === undefined) fail('--base needs a URL');
      base = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--base=')) {
      base = token.slice('--base='.length);
      continue;
    }
    rest.push(token);
  }
  return { base, rest };
}

/**
 * `--emotion joy=0.8 relaxed=0.2` takes as many values as follow it, which
 * `parseArgs` has no form for — it reads exactly one. The extra values are
 * folded back into repeats of the flag before parsing.
 */
export function expandGreedy(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    out.push(args[i]);
    if (args[i] !== flag) continue;
    for (let taken = 0; i + 1 < args.length && !args[i + 1].startsWith('-'); taken += 1) {
      if (taken > 0) out.push(flag);
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

/**
 * `--wait` takes an optional number of seconds; bare, it means "wait, with the
 * server's default timeout". `parseArgs` has no optional-value form, so a bare
 * one is rewritten to the `1` that the server reads as that default.
 */
export function normaliseWait(args: string[]): string[] {
  return args.map((token, i) => {
    if (token !== '--wait') return token;
    const next = args[i + 1];
    return next !== undefined && NUMBER.test(next) ? token : '--wait=1';
  });
}

/**
 * Pull the numeric positionals out ahead of `parseArgs`, which reads a leading
 * `-` as a short option — without this a negative bearing is an unknown flag
 * rather than a direction.
 */
export function extractNumbers(
  args: string[],
  valueFlags: string[],
): { numbers: string[]; rest: string[] } {
  const numbers: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (valueFlags.includes(token)) {
      rest.push(token);
      if (args[i + 1] !== undefined) {
        rest.push(args[i + 1]);
        i += 1;
      }
      continue;
    }
    if (NUMBER.test(token)) numbers.push(token);
    else rest.push(token);
  }
  return { numbers, rest };
}

// --- values -----------------------------------------------------------------

export function toNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) fail(`${label} takes a number: ${raw}`);
  return value;
}

/** `--emotion joy=0.8 relaxed=0.2` -> `{ joy: 0.8, relaxed: 0.2 }`. */
export function parseVec(pairs: string[] | undefined): Record<string, number> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const vec: Record<string, number> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = at === -1 ? pair : pair.slice(0, at);
    const raw = at === -1 ? '' : pair.slice(at + 1);
    vec[name] = raw === '' ? 1.0 : toNumber(raw, 1.0, `--emotion ${name}`);
  }
  return vec;
}

/** Split on the first separator only. `null` when there is none. */
export function splitOnce(value: string, separator: string): [string, string | null] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + separator.length)];
}

/**
 * Validate one command before it goes on the wire.
 *
 * An emotion name or a camera frame the avatar does not have is caught here,
 * against the same schema the viewer applies, rather than being posted and
 * silently ignored at the other end.
 */
export function build<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || 'command'}: ${issue.message}`)
      .join(', ');
    fail(`Invalid arguments: ${detail}`);
  }
  return parsed.data;
}
