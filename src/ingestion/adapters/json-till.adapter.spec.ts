import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldError, NewSale, Result } from '../../canonical';
import { JsonTillAdapter } from './json-till.adapter';

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/json', name));
const fixtureObject = (name: string) =>
  JSON.parse(fixture(name).toString()) as Record<string, unknown> & {
    lines: Record<string, unknown>[];
    payment: Record<string, unknown>;
  };
const asBuffer = (value: unknown) => Buffer.from(JSON.stringify(value));

const BOM = String.fromCharCode(0xfeff);
const adapter = new JsonTillAdapter();

function errors(result: Result<NewSale>): FieldError[] {
  if (result.ok) throw new Error('expected parse to fail');
  return result.errors;
}

describe('JsonTillAdapter', () => {
  describe('valid fixtures', () => {
    it.each(['ev-charging.json', 'parking.json', 'shop.json'])('parses %s', (name) => {
      const result = adapter.parse(fixture(name));
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.source).toEqual({ format: 'json', schemaVersion: '1' });
    });

    it('maps the EV charging sale to the canonical model', () => {
      const result = adapter.parse(fixture('ev-charging.json'));
      expect(result.ok && result.value).toMatchObject({
        terminalId: 'TERM0001',
        occurredAt: '2026-10-15T14:30:00Z',
        totalMinor: 1132,
        lines: [
          expect.objectContaining({ quantity: 18.5, unit: 'KWH', lineTotalMinor: 832 }),
          expect.anything(),
        ],
        metadata: { connectorId: 'CCS2-2', sessionId: 'chg-77812' },
      });
      expect(result.ok && 'schemaVersion' in result.value).toBe(false);
    });

    it('accepts a UTF-8 BOM and surrounding whitespace', () => {
      const raw = Buffer.concat([
        Buffer.from(`${BOM}  \n`),
        fixture('parking.json'),
        Buffer.from('\n'),
      ]);
      expect(adapter.parse(raw).ok).toBe(true);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['', 'empty body'],
      ['   ', 'empty body'],
      ['{"terminalId": "T1",}', 'malformed JSON at position 20'],
      ['{"terminalId"', 'malformed JSON at position 13'],
      ['{"a":', 'malformed JSON'], // V8 gives no position for a truncated body
    ])('%p → %p', (body, message) => {
      expect(errors(adapter.parse(Buffer.from(body)))).toEqual([{ path: '(root)', message }]);
    });

    it.each(['[]', '"sale"', '42', 'null'])('rejects non-object JSON %p', (body) => {
      expect(errors(adapter.parse(Buffer.from(body)))).toEqual([
        { path: '(root)', message: 'must be a JSON object' },
      ]);
    });

    it('never echoes the raw body in a parse error', () => {
      const result = adapter.parse(Buffer.from('4111111111111111 is my card'));
      expect(JSON.stringify(errors(result))).not.toContain('4111');
    });
  });

  describe('schema version', () => {
    it.each([
      [undefined, 'null'],
      ['2', '"2"'],
      [1, '1'],
    ])('rejects %p', (schemaVersion, shown) => {
      const body = { ...fixtureObject('parking.json'), schemaVersion };
      expect(errors(adapter.parse(asBuffer(body)))).toEqual([
        { path: 'schemaVersion', message: `unsupported schema version ${shown}; supported: 1` },
      ]);
    });
  });

  describe('field-level errors', () => {
    it('rejects unknown fields by name, catching typos', () => {
      const { totalMinor, ...rest } = fixtureObject('parking.json');
      const body = { ...rest, totalMnior: totalMinor };
      expect(errors(adapter.parse(asBuffer(body)))).toEqual(
        expect.arrayContaining([
          { path: 'totalMnior', message: 'unknown field' },
          expect.objectContaining({ path: 'totalMinor' }),
        ]),
      );
    });

    it('rejects unknown fields in nested objects', () => {
      const body = fixtureObject('parking.json');
      body.payment.pan = '4111111111111111';
      expect(errors(adapter.parse(asBuffer(body)))).toEqual([
        { path: 'payment.pan', message: 'unknown field' },
      ]);
    });

    it('rejects gateway-owned fields', () => {
      const body = {
        ...fixtureObject('parking.json'),
        status: 'CAPTURED',
        source: { format: 'xml' },
      };
      expect(errors(adapter.parse(asBuffer(body)))).toEqual([
        { path: 'status', message: 'unknown field' },
        { path: 'source', message: 'unknown field' },
      ]);
    });

    it('reports every missing field with its path', () => {
      const body = fixtureObject('ev-charging.json');
      delete body.currency;
      delete body.lines[1]!.unitPriceMinor;
      const paths = errors(adapter.parse(asBuffer(body))).map((e) => e.path);
      expect(paths).toEqual(['currency', 'lines[1].unitPriceMinor']);
    });

    it.each([
      ['totalMinor', 11.32],
      ['totalMinor', '1132'],
      ['occurredAt', '2026-10-15T15:30:00+01:00'],
      ['currency', 'eur'],
    ])('rejects a bad %s (%p)', (field, value) => {
      const body = { ...fixtureObject('ev-charging.json'), [field]: value };
      expect(errors(adapter.parse(asBuffer(body)))).toContainEqual(
        expect.objectContaining({ path: field }),
      );
    });

    it('applies the canonical cross-field rules', () => {
      const body = { ...fixtureObject('ev-charging.json'), totalMinor: 1000 };
      expect(errors(adapter.parse(asBuffer(body)))).toEqual([
        { path: 'totalMinor', message: 'must equal the sum of lineTotalMinor (1132)' },
      ]);
    });
  });

  describe('looksLike', () => {
    it.each(['{}', '  \n{"a":1}', `${BOM}{`])('recognises %p', (body) => {
      expect(adapter.looksLike(Buffer.from(body))).toBe(true);
    });

    it.each(['<sale/>', 'H TERM0001', '[{}]', ''])('ignores %p', (body) => {
      expect(adapter.looksLike(Buffer.from(body))).toBe(false);
    });
  });
});
