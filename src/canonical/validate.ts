import type { z } from 'zod';
import { fail, ok, type FieldError, type Result } from './result';
import { newSaleSchema, type NewSale } from './transaction.schema';

/** Validates adapter output against the canonical model. Never throws on bad input. */
export function validateNewSale(input: unknown): Result<NewSale> {
  const parsed = newSaleSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(toFieldErrors(parsed.error));
}

/** One error per offending field; unknown keys are reported at their own path. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          path: formatPath([...issue.path, key]),
          message: 'unknown field',
        }))
      : [{ path: formatPath(issue.path), message: issue.message }],
  );
}

/** `['lines', 2, 'quantity']` → `lines[2].quantity` */
export function formatPath(path: readonly PropertyKey[]): string {
  return (
    path.reduce<string>((acc, key) => {
      if (typeof key === 'number') return `${acc}[${key}]`;
      return acc ? `${acc}.${String(key)}` : String(key);
    }, '') || '(root)'
  );
}
