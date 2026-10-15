import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldError, NewSale, Result } from '../../canonical';
import { JsonTillAdapter } from './json-till.adapter';
import { decimalToInteger, toUtc, XmlTillAdapter } from './xml-till.adapter';

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures', name));
const adapter = new XmlTillAdapter();

/** A valid sale; `edit` replaces fragments to produce one specific defect. */
const evXml = () => fixture('xml/ev-charging.xml').toString('utf8');
const edited = (...replacements: [string, string][]) =>
  Buffer.from(replacements.reduce((xml, [from, to]) => xml.replace(from, to), evXml()));

function errors(result: Result<NewSale>): FieldError[] {
  if (result.ok) throw new Error('expected parse to fail');
  return result.errors;
}

describe('XmlTillAdapter', () => {
  describe('fixtures', () => {
    it.each(['ev-charging.xml', 'parking-latin1.xml', 'shop.xml'])('parses %s', (name) => {
      const result = adapter.parse(fixture(`xml/${name}`));
      expect(result.ok ? 'ok' : result.errors).toBe('ok');
    });

    it('produces the same canonical sale as the equivalent JSON till payload', () => {
      const xml = adapter.parse(fixture('xml/ev-charging.xml'));
      const json = new JsonTillAdapter().parse(fixture('json/ev-charging.json'));
      if (!xml.ok || !json.ok) throw new Error('both fixtures must parse');

      const { source: xmlSource, ...xmlSale } = xml.value;
      const { source: _jsonSource, metadata: _metadata, ...jsonSale } = json.value;
      expect(xmlSale).toEqual(jsonSale);
      expect(xmlSource).toEqual({ format: 'xml', schemaVersion: '1' });
    });

    it('honours the declared ISO-8859-1 encoding', () => {
      const result = adapter.parse(fixture('xml/parking-latin1.xml'));
      expect(result.ok && result.value.lines[0]!.description).toBe(
        'Estacionamento Saldanha (1.º piso)',
      );
    });

    it('decodes predefined entities and keeps UTF-8 text', () => {
      const result = adapter.parse(fixture('xml/shop.xml'));
      expect(result.ok && result.value.lines.map((l) => l.description)).toEqual([
        'Gasóleo',
        'Café & pastel de nata',
        'Sandes de presunto',
      ]);
    });
  });

  describe('security', () => {
    it.each([
      [
        'XXE: external entity reading a local file',
        '<!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
      ],
      [
        'XXE: external entity over the network',
        '<!DOCTYPE s [<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/">]>',
      ],
      [
        'billion laughs',
        '<!DOCTYPE l [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>',
      ],
      ['internal entity', '<!DOCTYPE s [<!ENTITY x "hello">]>'],
      ['lowercase doctype', '<!doctype s>'],
    ])('rejects a DTD: %s', (_name, dtd) => {
      const body = edited(
        ['<Sale schemaVersion="1">', `${dtd}\n<Sale schemaVersion="1">`],
        ['<Receipt>R000123', '<Receipt>&x;R000123'],
      );
      expect(errors(adapter.parse(body))).toEqual([
        { path: '(document)', message: 'DOCTYPE and entity declarations are not allowed' },
      ]);
    });

    it('rejects prototype-pollution element names without throwing', () => {
      const body = edited([
        '<Merchant>',
        '<__proto__><polluted>yes</polluted></__proto__><Merchant>',
      ]);
      expect(errors(adapter.parse(body))).toEqual([
        { path: '(document)', message: 'malformed or disallowed XML' },
      ]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('never quotes input in well-formedness errors', () => {
      const body = edited(['<Receipt>R000123</Receipt>', '<4111111111111111>x</4111111111111111>']);
      expect(JSON.stringify(errors(adapter.parse(body)))).not.toContain('4111');
    });
  });

  describe('well-formedness and encoding', () => {
    it('rejects mismatched tags that the parser alone would accept', () => {
      expect(errors(adapter.parse(edited(['</Merchant>', '</Merchnt>'])))).toEqual([
        { path: 'line 4, col 20', message: 'malformed XML (InvalidTag)' },
      ]);
    });

    it.each([
      ['', 'empty body'],
      [
        '<?xml version="1.0" encoding="UTF-16"?><Sale/>',
        'unsupported encoding; use UTF-8 or ISO-8859-1',
      ],
    ])('rejects %p', (body, message) => {
      expect(errors(adapter.parse(Buffer.from(body)))[0]!.message).toBe(message);
    });

    it('rejects Latin-1 bytes sent without declaring the encoding', () => {
      const latin1 = fixture('xml/parking-latin1.xml')
        .toString('latin1')
        .replace(' encoding="ISO-8859-1"', '');
      expect(errors(adapter.parse(Buffer.from(latin1, 'latin1')))[0]!.message).toMatch(
        /^not valid UTF-8/,
      );
    });

    it.each([
      ['<Order schemaVersion="1"/>', 'root element must be <Sale>; got <Order>'],
      ['<Sale schemaVersion="2"/>', 'unsupported schema version "2"; supported: 1'],
      ['<Sale/>', 'unsupported schema version null; supported: 1'],
    ])('rejects %p', (body, message) => {
      expect(errors(adapter.parse(Buffer.from(body)))[0]!.message).toBe(message);
    });
  });

  describe('errors point at the element path', () => {
    it('names unknown elements and attributes (strict, like the JSON format)', () => {
      const body = edited(
        ['<Currency>', '<Curency>EUR</Curency><Currency>'],
        ['method="CARD"', 'method="CARD" pan="4111"'],
      );
      expect(errors(adapter.parse(body))).toEqual([
        { path: '/Sale/Payment/@pan', message: 'unknown element or attribute' },
        { path: '/Sale/Curency', message: 'unknown element or attribute' },
      ]);
    });

    it('reports a missing element and a missing attribute', () => {
      const body = edited(
        ['<Site>SITE042</Site>', ''],
        ['<Quantity unit="MINUTE">60', '<Quantity>60'],
      );
      expect(errors(adapter.parse(body)).map((e) => e.path)).toEqual([
        '/Sale/Site',
        '/Sale/Lines/Line[2]/Quantity/@unit',
      ]);
    });

    it('rejects a repeated element', () => {
      const body = edited([
        '<Merchant>MERCH01</Merchant>',
        '<Merchant>MERCH01</Merchant><Merchant>X</Merchant>',
      ]);
      expect(errors(adapter.parse(body))).toContainEqual(
        expect.objectContaining({ path: '/Sale/Merchant' }),
      );
    });

    it.each([
      [
        ['<LineTotal>8.32', '<LineTotal>8.325'],
        '/Sale/Lines/Line[1]/LineTotal',
        'must be a decimal amount with at most 2 decimal places',
      ],
      [
        ['<UnitPrice>0.45', '<UnitPrice>0,45'],
        '/Sale/Lines/Line[1]/UnitPrice',
        'must be a decimal amount with at most 2 decimal places',
      ],
      [
        ['<Total>11.32', '<Total>-11.32'],
        '/Sale/Totals/Total',
        'must be a decimal amount with at most 2 decimal places',
      ],
      [
        ['<Quantity unit="KWH">18.500', '<Quantity unit="KWH">18.5001'],
        '/Sale/Lines/Line[1]/Quantity',
        'must be a decimal with at most 3 decimal places',
      ],
      [
        ['<TaxRate>23.00', '<TaxRate>23%'],
        '/Sale/Lines/Line[1]/TaxRate',
        'must be a percentage with at most 2 decimal places, e.g. 23 or 23.00',
      ],
    ])('reports bad numbers: %p', (replacement, path, message) => {
      expect(errors(adapter.parse(edited(replacement as [string, string])))).toEqual([
        { path, message },
      ]);
    });

    it.each([
      [['<Total>11.32', '<Total>11.33'], '/Sale/Totals/Total'],
      [['<Currency>EUR', '<Currency>XYZ'], '/Sale/Currency'],
      [['unit="KWH"', 'unit="GALLON"'], '/Sale/Lines/Line[1]/Quantity/@unit'],
      [['method="CARD"', 'method="CASH"'], '/Sale/Payment/@method'],
      [['<Token>tok_8f3kD92LmQ', '<Token>4111111111111111'], '/Sale/Payment/Token'],
      [['15:30:00+01:00', '15:30:00'], '/Sale/OccurredAt'],
    ])('maps canonical errors back to XML paths: %p', (replacement, path) => {
      expect(errors(adapter.parse(edited(replacement as [string, string])))).toContainEqual(
        expect.objectContaining({ path }),
      );
    });
  });

  describe('looksLike', () => {
    it.each(['<?xml version="1.0"?><Sale/>', '  \n<Sale/>'])('recognises %p', (body) => {
      expect(adapter.looksLike(Buffer.from(body))).toBe(true);
    });

    it.each(['{"a":1}', 'H01MERCH01'])('ignores %p', (body) => {
      expect(adapter.looksLike(Buffer.from(body))).toBe(false);
    });
  });
});

describe('decimalToInteger', () => {
  it.each([
    ['8.32', 2, 832],
    ['8.3', 2, 830],
    ['8', 2, 800],
    ['0.07', 2, 7],
    ['1234', 0, 1234], // JPY
    ['1.234', 3, 1234], // KWD
    ['23.00', 2, 2300], // tax rate %
  ])('%p with %d digits → %d', (value, digits, expected) => {
    expect(decimalToInteger(value, digits)).toBe(expected);
  });

  it.each(['8.325', '8,32', '-1', '1e3', '', ' 8', '.5', '99999999999999999'])(
    'rejects %p',
    (value) => {
      expect(decimalToInteger(value, 2)).toBeUndefined();
    },
  );

  it('avoids float drift', () => {
    expect(Number('8.3') * 100).not.toBe(830); // why string arithmetic is used
    expect(decimalToInteger('8.3', 2)).toBe(830);
  });
});

describe('toUtc', () => {
  it.each([
    ['2026-10-15T15:30:00+01:00', '2026-10-15T14:30:00Z'],
    ['2026-10-15T09:30:00-05:00', '2026-10-15T14:30:00Z'],
    ['2026-10-15T00:30:00+01:00', '2026-10-14T23:30:00Z'], // crosses midnight
    ['2026-10-15T15:30:00.250+01:00', '2026-10-15T14:30:00.250Z'],
    ['2026-10-15T14:30:00Z', '2026-10-15T14:30:00Z'], // already UTC
  ])('%p → %p', (input, expected) => {
    expect(toUtc(input)).toBe(expected);
  });

  it.each([
    '2026-02-30T10:00:00+01:00', // Date would roll over to March 2
    '2026-10-15T24:00:00+01:00', // Date would roll over to the next day
    '2026-10-15T15:30:00', // no zone: ambiguous local time
  ])('leaves %p unconverted for the canonical check to reject', (input) => {
    expect(toUtc(input)).toBe(input);
  });
});
