/**
 * Type-level guards.
 *
 * Every schema in this directory that mirrors an engine type is followed by one
 * of these, so a field added on one side and not the other is a compile error
 * rather than a runtime surprise on somebody's stream.
 */

/**
 * True only when `A` and `B` are the same type, rather than merely mutually
 * assignable. Assignability tolerates an extra optional field on either side,
 * which is precisely the drift these guards exist to catch.
 */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Turns a failed `Equals` into a compile error at the point of use. */
export type Expect<T extends true> = T;

/**
 * `Assert<A, B>` compiles only if `A` is assignable to `B`. Used in pairs where
 * `Equals` is too literal — an intersection and the flat object with the same
 * members are interchangeable but not identical.
 */
export type Assert<A extends B, B = A> = A;
