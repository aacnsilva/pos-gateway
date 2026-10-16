import { fail, validateNewSale, type NewSale, type Result } from '../../src/canonical';
import type { PosFormatAdapter } from '../../src/ingestion';

/**
 * Dummy till format used to prove the extension point: `PIPE|` followed by a JSON sale.
 * Lives under test/ on purpose: registering it touches nothing in src/.
 */
export class PipeJsonAdapter implements PosFormatAdapter {
  readonly format = 'pipe-json';
  readonly mediaTypes = ['text/x-pipe-sale'];

  looksLike(raw: Buffer): boolean {
    return raw.subarray(0, 5).toString('latin1') === 'PIPE|';
  }

  parse(raw: Buffer): Result<NewSale> {
    const text = raw.toString('utf8');
    if (!text.startsWith('PIPE|')) {
      return fail([{ path: '(root)', message: 'must start with PIPE|' }]);
    }
    let body: unknown;
    try {
      body = JSON.parse(text.slice(5));
    } catch {
      return fail([{ path: '(root)', message: 'malformed JSON after PIPE|' }]);
    }
    return validateNewSale({
      ...(body as object),
      source: { format: this.format, schemaVersion: '1' },
    });
  }
}
