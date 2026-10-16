import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldError, NewSale, Result } from '../../canonical';
import { FixedWidthTillAdapter } from './fixed-width.adapter';
import { fieldEnd, LAYOUT, RECORD_LENGTH } from './fixed-width.layout';
import { JsonTillAdapter } from './json-till.adapter';

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures', name));
const adapter = new FixedWidthTillAdapter();

/** Record builders mirroring the layout, so each test changes exactly one thing. */
const rec = {
  H: (o: { ts?: string; cur?: string; version?: string } = {}) =>
    `H${o.version ?? '01'}${'MERCH01'.padEnd(12)}${'SITE042'.padEnd(12)}${'TERM0001'.padEnd(12)}${o.ts ?? '20261015T143000Z'}${o.cur ?? 'EUR'}${'R000123'.padEnd(20)}  `,
  L: (o: { desc?: string; qty?: string; unit?: string; price?: string; total?: string } = {}) =>
    `L${'EV-KWH'.padEnd(12)}${(o.desc ?? 'DC fast charge').padEnd(30)}${o.qty ?? '0000018500'}${o.unit ?? 'K'}${o.price ?? '000000045'}${o.total ?? '000000832'}02300   `,
  P: (o: { method?: string; token?: string } = {}) =>
    `P${o.method ?? 'C'}${(o.token ?? 'tok_8f3kD92LmQ').padEnd(68)}${'VISA'.padEnd(10)}`,
  T: (o: { count?: string; total?: string; tax?: string } = {}) =>
    `T${o.count ?? '0001'}${o.total ?? '00000000832'}${o.tax ?? '00000000156'}${' '.repeat(53)}`,
};
const file = (...records: string[]) => Buffer.from(records.join('\n') + '\n', 'latin1');
const valid = () => [rec.H(), rec.L(), rec.P(), rec.T()];

function errors(result: Result<NewSale>): FieldError[] {
  if (result.ok) throw new Error('expected parse to fail');
  return result.errors;
}

describe('FixedWidthTillAdapter', () => {
  it('builders produce 80-byte records', () => {
    for (const r of valid()) expect(r).toHaveLength(RECORD_LENGTH);
  });

  describe('fixtures', () => {
    it.each(['ev-charging.txt', 'parking-accents.txt', 'shop-crlf.txt'])('parses %s', (name) => {
      const result = adapter.parse(fixture(`fixed-width/${name}`));
      expect(result.ok ? 'ok' : result.errors).toBe('ok');
    });

    it('produces the same canonical sale as the equivalent JSON till payload', () => {
      const fixed = adapter.parse(fixture('fixed-width/ev-charging.txt'));
      const json = new JsonTillAdapter().parse(fixture('json/ev-charging.json'));
      if (!fixed.ok || !json.ok) throw new Error('both fixtures must parse');

      const { source: fixedSource, ...fixedSale } = fixed.value;
      const { source: _jsonSource, metadata: _metadata, ...jsonSale } = json.value;
      expect(fixedSale).toEqual(jsonSale);
      expect(fixedSource).toEqual({ format: 'fixed-width', schemaVersion: '01' });
    });

    it('decodes ISO-8859-1 descriptions', () => {
      const result = adapter.parse(fixture('fixed-width/parking-accents.txt'));
      expect(result.ok && result.value.lines[0]!.description).toBe('Estacionamento Saldanha (1.º)');
    });

    it('converts implied decimals and units', () => {
      const result = adapter.parse(fixture('fixed-width/shop-crlf.txt'));
      expect(result.ok && result.value.lines[0]).toMatchObject({ quantity: 42.37, unit: 'LITRE' });
    });
  });

  describe('line endings and whitespace', () => {
    it('accepts CRLF, LF and no final newline', () => {
      for (const body of [
        valid().join('\r\n'),
        valid().join('\n'),
        valid().join('\r\n') + '\r\n',
      ]) {
        expect(adapter.parse(Buffer.from(body, 'latin1')).ok).toBe(true);
      }
    });

    it('ignores trailing blank lines and trailing spaces past column 80', () => {
      const [h, l, p, t] = valid();
      expect(adapter.parse(file(h!, l! + '    ', p!, t!, '', '')).ok).toBe(true);
    });

    it('rejects a blank line between records', () => {
      const [h, l, p, t] = valid();
      expect(errors(adapter.parse(file(h!, '', l!, p!, t!)))).toEqual([
        { path: 'record 2', message: 'unknown record type ""' },
      ]);
    });

    it('rejects an empty body', () => {
      expect(errors(adapter.parse(Buffer.from('\r\n\n')))).toEqual([
        { path: '(file)', message: 'empty body' },
      ]);
    });
  });

  describe('record length', () => {
    it('rejects a short record (e.g. an editor stripped trailing spaces)', () => {
      const [h, l, p, t] = valid();
      expect(errors(adapter.parse(file(h!, l!, p!.trimEnd(), t!)))).toEqual([
        { path: 'record 3 [P]', message: 'record is 74 bytes, expected 80' },
      ]);
    });

    it('rejects a long record whose extra bytes are not spaces', () => {
      const [h, l, p, t] = valid();
      expect(errors(adapter.parse(file(h!, l! + 'X', p!, t!)))).toEqual([
        { path: 'record 2 [L]', message: 'record is 81 bytes, expected 80' },
      ]);
    });

    it('explains the likely cause when the file was sent as UTF-8', () => {
      const body = Buffer.from(
        file(rec.H(), rec.L({ desc: 'Café' }), rec.P(), rec.T()).toString('latin1'),
        'utf8',
      );
      expect(errors(adapter.parse(body))).toEqual([
        {
          path: 'record 2 [L]',
          message:
            'record is 81 bytes, expected 80; it looks UTF-8 encoded, but this format is ISO-8859-1',
        },
      ]);
    });

    it('does not mistake Latin-1 accents plus trailing spaces for UTF-8', () => {
      const body = file(rec.H(), rec.L({ desc: 'Café expresso' }) + '   ', rec.P(), rec.T());
      expect(adapter.parse(body).ok).toBe(true);
    });

    it('rejects control characters such as tabs', () => {
      const body = file(rec.H(), rec.L({ desc: 'DC\tfast' }), rec.P(), rec.T());
      expect(errors(adapter.parse(body))).toEqual([
        { path: 'record 2 [L] col 16', message: 'control character not allowed' },
      ]);
    });
  });

  describe('field errors point at record and columns', () => {
    it('reports a non-numeric quantity', () => {
      expect(
        errors(adapter.parse(file(rec.H(), rec.L({ qty: '18.5000000' }), rec.P(), rec.T()))),
      ).toEqual([
        { path: 'record 2 [L] cols 44-53 quantity', message: 'must be 10 digits, zero-padded' },
      ]);
    });

    it('reports space padding in a numeric field', () => {
      expect(
        errors(adapter.parse(file(rec.H(), rec.L({ price: '       45' }), rec.P(), rec.T()))),
      ).toEqual([
        {
          path: 'record 2 [L] cols 55-63 unitPriceMinor',
          message: 'must be 9 digits, zero-padded',
        },
      ]);
    });

    it('flags shifted columns through the reserved filler', () => {
      // one extra character in the description pushes every later field right by one
      const shifted = rec.L().slice(0, 13) + ' ' + rec.L().slice(13, 79);
      const result = errors(adapter.parse(file(rec.H(), shifted, rec.P(), rec.T())));
      expect(result).toContainEqual({
        path: 'record 2 [L] cols 78-80 reserved',
        message: 'reserved, must be spaces (are the columns shifted?)',
      });
    });

    it('reports every bad field across records in one response', () => {
      const body = file(
        rec.H(),
        rec.L({ qty: 'XXXXXXXXXX' }),
        rec.P(),
        rec.T({ total: '0000000083A' }),
      );
      expect(errors(adapter.parse(body)).map((e) => e.path)).toEqual([
        'record 2 [L] cols 44-53 quantity',
        'record 4 [T] cols 6-16 totalMinor',
      ]);
    });

    it.each([
      [{ unit: 'X' }, 'record 2 [L] col 54 unit', 'unknown unit code; expected one of I, K, M, L'],
    ])('rejects unknown codes %p', (line, path, message) => {
      expect(errors(adapter.parse(file(rec.H(), rec.L(line), rec.P(), rec.T())))).toEqual([
        { path, message },
      ]);
    });

    it('rejects an unknown payment method code', () => {
      expect(
        errors(adapter.parse(file(rec.H(), rec.L(), rec.P({ method: 'Z' }), rec.T()))),
      ).toEqual([
        {
          path: 'record 3 [P] col 2 method',
          message: 'unknown method code; expected one of C, W, F',
        },
      ]);
    });

    it('rejects an unsupported layout version', () => {
      expect(
        errors(adapter.parse(file(rec.H({ version: '02' }), rec.L(), rec.P(), rec.T()))),
      ).toEqual([
        {
          path: 'record 1 [H] cols 2-3 layoutVersion',
          message: 'unsupported layout version; supported: 01',
        },
      ]);
    });
  });

  describe('canonical errors are mapped back to the source columns', () => {
    it.each([
      [
        file(rec.H(), rec.L(), rec.P(), rec.T({ total: '00000000999' })),
        'record 4 [T] cols 6-16 totalMinor',
      ],
      [
        file(rec.H(), rec.L({ total: '000000900' }), rec.P(), rec.T({ total: '00000000900' })),
        'record 2 [L] cols 64-72 lineTotalMinor',
      ],
      [
        file(rec.H({ ts: '20261315T143000Z' }), rec.L(), rec.P(), rec.T()),
        'record 1 [H] cols 40-55 occurredAt',
      ],
      [
        file(rec.H({ ts: '2026-10-15T1430Z' }), rec.L(), rec.P(), rec.T()),
        'record 1 [H] cols 40-55 occurredAt',
      ],
      [file(rec.H({ cur: 'XYZ' }), rec.L(), rec.P(), rec.T()), 'record 1 [H] cols 56-58 currency'],
      [
        file(rec.H(), rec.L(), rec.P({ token: '4111111111111111' }), rec.T()),
        'record 3 [P] cols 3-70 paymentToken',
      ],
    ])('%#: %s', (body, path) => {
      expect(errors(adapter.parse(body))).toContainEqual(expect.objectContaining({ path }));
    });
  });

  describe('file structure', () => {
    it.each([
      [[rec.L(), rec.H(), rec.P(), rec.T()], 'LHPT'],
      [[rec.H(), rec.P(), rec.T()], 'HPT'],
      [[rec.H(), rec.L(), rec.T()], 'HLT'],
      [[rec.H(), rec.L(), rec.P(), rec.T(), rec.L()], 'HLPTL'],
      [[rec.H(), rec.H(), rec.L(), rec.P(), rec.T()], 'HHLPT'],
    ])('rejects order %#', (records, order) => {
      expect(errors(adapter.parse(file(...records)))).toEqual([
        {
          path: '(file)',
          message: `records must be H, L (one or more), P, T in that order; got ${order}`,
        },
      ]);
    });

    it('rejects an unknown record type', () => {
      expect(
        errors(adapter.parse(file(rec.H(), 'X'.padEnd(80), rec.L(), rec.P(), rec.T()))),
      ).toEqual([{ path: 'record 2', message: 'unknown record type "X"' }]);
    });

    it('detects a truncated file through the trailer line count', () => {
      expect(
        errors(adapter.parse(file(rec.H(), rec.L(), rec.P(), rec.T({ count: '0002' })))),
      ).toEqual([
        { path: 'record 4 [T] cols 2-5 lineCount', message: 'says 2 lines but the file has 1' },
      ]);
    });

    it('never throws on arbitrary bytes', () => {
      for (const body of [
        Buffer.from([0xff, 0x00, 0x0a, 0x0d]),
        Buffer.from('{"json": true}'),
        Buffer.alloc(5000, 0x41),
      ]) {
        expect(() => adapter.parse(body)).not.toThrow();
        expect(adapter.parse(body).ok).toBe(false);
      }
    });
  });

  describe('looksLike', () => {
    it('recognises a layout-01 header', () => {
      expect(adapter.looksLike(fixture('fixed-width/ev-charging.txt'))).toBe(true);
    });

    it.each(['{"a":1}', '<sale/>', 'H02...', 'L...'])('ignores %p', (body) => {
      expect(adapter.looksLike(Buffer.from(body))).toBe(false);
    });
  });
});

describe('fixed-width layout', () => {
  it.each(Object.values(LAYOUT))('$type fields are contiguous and fill the record', (spec) => {
    let next = 1;
    for (const field of spec.fields) {
      expect([field.name, field.start]).toEqual([field.name, next]);
      next = fieldEnd(field) + 1;
    }
    expect(next - 1).toBe(RECORD_LENGTH);
  });
});
