import { acos, asin, atan2, cos, sin } from '@/core/math';

/** Replaced with the core's implementation for the scope. */
const CORE = { sin, cos, acos, asin, atan2 } as const;

/** Must not be reached inside the scope: the core has no fixed implementation of them. */
const FORBIDDEN = ['exp', 'log', 'tanh', 'cbrt', 'expm1', 'tan', 'atan', 'pow', 'hypot'] as const;

let calls = 0;
let active = false;

/** How many times a replaced function has been called inside `withCoreMath` since load. */
export function coreMathCalls(): number {
  return calls;
}

/**
 * Run `fn` synchronously with `Math.sin/cos/acos/asin/atan2` answered by the core and the
 * transcendentals the core does not fix made to throw. Every property is restored afterwards.
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
