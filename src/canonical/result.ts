/**
 * Validation and parsing return a Result instead of throwing: bad till input is an
 * expected outcome, not an exceptional one, and callers must handle it explicitly.
 */
export type Result<T, E = FieldError[]> = { ok: true; value: T } | { ok: false; errors: E };

export interface FieldError {
  /** Location of the offending value, e.g. `lines[2].quantity` or `fixed-width:L#3 cols 14-23`. */
  path: string;
  message: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(errors: E): Result<never, E> => ({ ok: false, errors });
