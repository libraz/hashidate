import {
  acos,
  asin,
  atan2,
  cbrt,
  cos,
  exp,
  expm1,
  hypot2,
  hypot3,
  log,
  sin,
  tanh,
} from '@/core/math';

/** `Math.hypot` answered by the core, which has an implementation for two and three arguments. */
function hypot(...args: number[]): number {
  if (args.length === 2) return hypot2(args[0], args[1]);
  if (args.length === 3) return hypot3(args[0], args[1], args[2]);
  throw new Error(`Math.hypot called with ${args.length} arguments inside withCoreMath`);
}

/** Replaced with the core's implementation for the scope. */
const CORE = { sin, cos, acos, asin, atan2, tanh, expm1, exp, log, cbrt, hypot } as const;

/** Must not be reached inside the scope: the core has no fixed implementation of them. */
const FORBIDDEN = [
  'tan',
  'atan',
  'pow',
  'sinh',
  'cosh',
  'asinh',
  'acosh',
  'atanh',
  'log1p',
  'log2',
  'log10',
] as const;

let calls = 0;
let active = false;

/** How many times a replaced function has been called inside `withCoreMath` since load. */
export function coreMathCalls(): number {
  return calls;
}

/**
 * Run `fn` synchronously with the transcendentals the core fixes (`sin`, `cos`, `acos`, `asin`,
 * `atan2`, `tanh`, `expm1`, `exp`, `log`, `cbrt`, `hypot`) answered by the core and the ones it
 * does not fix made to throw. Every property is restored afterwards.
 */
export function withCoreMath<T>(fn: () => T): T {
  if (active) throw new Error('withCoreMath does not nest');
  const math = globalThis.Math as unknown as Record<string, unknown>;
  const names = [...Object.keys(CORE), ...FORBIDDEN];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(math, name)] as const);
  active = true;
  try {
    for (const [name, impl] of Object.entries(CORE) as [string, (...args: number[]) => number][]) {
      math[name] = (...args: number[]) => {
        calls++;
        return impl(...args);
      };
    }
    for (const name of FORBIDDEN) {
      math[name] = () => {
        throw new Error(`Math.${name} called inside withCoreMath`);
      };
    }
    const value = fn();
    if (value instanceof Promise) throw new Error('withCoreMath takes a synchronous function');
    return value;
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(math, name, descriptor);
    }
    active = false;
  }
}
