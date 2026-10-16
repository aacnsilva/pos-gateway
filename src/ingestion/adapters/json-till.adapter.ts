import { Injectable } from '@nestjs/common';
import { fail, toFieldErrors, validateNewSale, type NewSale, type Result } from '../../canonical';
import type { PosFormatAdapter } from '../pos-format-adapter';
import { stripBom } from './text';
import { jsonSaleV1, SUPPORTED_JSON_SCHEMA_VERSIONS, type JsonSaleV1 } from './json-till.schema';

/** Modern JSON till payload (docs/formats/json.md). */
@Injectable()
export class JsonTillAdapter implements PosFormatAdapter {
  readonly format = 'json';
  readonly mediaTypes = ['application/json'];

  looksLike(raw: Buffer): boolean {
    const head = stripBom(raw.subarray(0, 64).toString('utf8')).trimStart();
    return head.startsWith('{');
  }

  parse(raw: Buffer): Result<NewSale> {
    const decoded = decodeJson(raw);
    if (!decoded.ok) return decoded;

    const body = decoded.value;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return fail([{ path: '(root)', message: 'must be a JSON object' }]);
    }

    const version = (body as Record<string, unknown>).schemaVersion;
    if (!SUPPORTED_JSON_SCHEMA_VERSIONS.includes(version as never)) {
      return fail([
        {
          path: 'schemaVersion',
          message: `unsupported schema version ${JSON.stringify(version ?? null)}; supported: ${SUPPORTED_JSON_SCHEMA_VERSIONS.join(', ')}`,
        },
      ]);
    }

    const wire = jsonSaleV1.safeParse(body);
    if (!wire.success) return fail(toFieldErrors(wire.error));

    // Cross-field rules (totals, line rounding) live in the canonical model, applied for every format.
    return validateNewSale(toCanonical(wire.data));
  }
}

function toCanonical({ schemaVersion, ...sale }: JsonSaleV1): NewSale {
  return { ...sale, source: { format: 'json', schemaVersion } };
}

/**
 * V8's JSON.parse messages quote a slice of the input (`"abc4111..." is not valid JSON`).
 * That could echo card data back to the caller or into logs, so only the position is kept.
 */
function decodeJson(raw: Buffer): Result<unknown> {
  const text = stripBom(raw.toString('utf8'));
  if (text.trim() === '') return fail([{ path: '(root)', message: 'empty body' }]);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const position = /position (\d+)/.exec(String(error))?.[1];
    return fail([
      {
        path: '(root)',
        message: position ? `malformed JSON at position ${position}` : 'malformed JSON',
      },
    ]);
  }
}
