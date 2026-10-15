import { fail, ok, type NewSale } from '../canonical';
import { PipeJsonAdapter } from '../../test/support/pipe-json.adapter';
import { parkingSale } from '../../test/support/sales';
import { AdapterRegistry, normaliseMediaType } from './adapter-registry';
import type { IngestionError } from './ingestion-error';
import { toHttpException } from './ingestion-http';
import type { PosFormatAdapter } from './pos-format-adapter';

/** Minimal fake adapter: sniffs a fixed prefix and records whether parse was called. */
function fakeAdapter(format: string, mediaTypes: string[], prefix: string): PosFormatAdapter {
  return {
    format,
    mediaTypes,
    looksLike: (raw) => raw.toString().startsWith(prefix),
    parse: () => fail([{ path: '(root)', message: `${format} parse called` }]),
  };
}

const xml = fakeAdapter('xml', ['application/xml', 'text/xml'], '<');
const json = fakeAdapter('json', ['application/json'], '{');
const body = (s: string) => Buffer.from(s);

describe('AdapterRegistry', () => {
  const registry = new AdapterRegistry([json, xml]);

  describe('a specific Content-Type is authoritative', () => {
    it('routes by media type', () => {
      expect(registry.resolve('application/xml', body('<sale/>'))).toEqual(ok(xml));
      expect(registry.resolve('text/xml', body('<sale/>'))).toEqual(ok(xml));
    });

    it('ignores parameters and case', () => {
      expect(registry.resolve('Application/JSON; charset=utf-8', body('{}'))).toEqual(ok(json));
    });

    it('does not sniff when the header and body disagree', () => {
      // XML body labelled as JSON goes to the JSON adapter, which will reject it with a 400
      expect(registry.resolve('application/json', body('<sale/>'))).toEqual(ok(json));
    });

    it('rejects an unknown specific type with the supported list', () => {
      expect(registry.resolve('text/csv', body('a,b'))).toEqual(
        fail({
          kind: 'unsupported-media-type',
          mediaType: 'text/csv',
          supported: ['application/json', 'application/xml', 'text/xml'],
        }),
      );
    });
  });

  describe('missing or generic Content-Type falls back to sniffing', () => {
    it.each([undefined, '', 'application/octet-stream'])('sniffs for %p', (contentType) => {
      expect(registry.resolve(contentType, body('<sale/>'))).toEqual(ok(xml));
    });

    it('rejects a body no adapter recognises', () => {
      expect(registry.resolve(undefined, body('H|TERM0001'))).toEqual(
        fail({ kind: 'unrecognised-body', candidates: [] }),
      );
    });

    it('rejects an ambiguous body instead of guessing', () => {
      const other = fakeAdapter('other-json', ['application/vnd.other+json'], '{');
      const ambiguous = new AdapterRegistry([json, other]);
      expect(ambiguous.resolve(undefined, body('{}'))).toEqual(
        fail({ kind: 'unrecognised-body', candidates: ['json', 'other-json'] }),
      );
    });
  });

  describe('registration fails fast at startup', () => {
    it('rejects two adapters with the same format', () => {
      expect(() => new AdapterRegistry([json, json])).toThrow('Duplicate POS format adapter: json');
    });

    it('rejects two adapters claiming the same media type', () => {
      const clash = fakeAdapter('json2', ['application/json'], '[');
      expect(() => new AdapterRegistry([json, clash])).toThrow(
        'Media type application/json claimed by both json and json2',
      );
    });
  });

  describe('parse', () => {
    const withPipe = new AdapterRegistry([json, new PipeJsonAdapter()]);

    it('returns the canonical sale from a registered adapter', () => {
      const raw = body(`PIPE|${JSON.stringify(parkingSale())}`);
      const result = withPipe.parse('text/x-pipe-sale', raw);
      expect(result).toEqual(
        ok<NewSale>({ ...parkingSale(), source: { format: 'pipe-json', schemaVersion: '1' } }),
      );
    });

    it('wraps adapter errors with the format', () => {
      const result = withPipe.parse('text/x-pipe-sale', body('PIPE|{not json'));
      expect(result).toEqual(
        fail({
          kind: 'invalid-payload',
          format: 'pipe-json',
          errors: [{ path: '(root)', message: 'malformed JSON after PIPE|' }],
        }),
      );
    });

    it('does not call any adapter when the media type is unsupported', () => {
      const parse = jest.fn();
      const spy: PosFormatAdapter = { ...json, parse };
      new AdapterRegistry([spy]).parse('text/csv', body('a,b'));
      expect(parse).not.toHaveBeenCalled();
    });
  });
});

describe('normaliseMediaType', () => {
  it.each([
    [undefined, ''],
    ['  TEXT/Plain ; charset=ISO-8859-1', 'text/plain'],
    ['application/json', 'application/json'],
  ])('%p → %p', (input, expected) => {
    expect(normaliseMediaType(input)).toBe(expected);
  });
});

describe('toHttpException', () => {
  it('maps an unsupported media type to 415', () => {
    const e = toHttpException({
      kind: 'unsupported-media-type',
      mediaType: 'text/csv',
      supported: [],
    });
    expect(e.getStatus()).toBe(415);
  });

  it.each<IngestionError>([
    { kind: 'unrecognised-body', candidates: [] },
    { kind: 'invalid-payload', format: 'json', errors: [] },
  ])('maps $kind to 400', (error) => {
    expect(toHttpException(error).getStatus()).toBe(400);
  });

  it('exposes field errors to the till', () => {
    const errors = [{ path: 'lines[0].quantity', message: 'Too small' }];
    const e = toHttpException({ kind: 'invalid-payload', format: 'json', errors });
    expect(e.getResponse()).toEqual({ error: 'invalid_payload', format: 'json', errors });
  });
});
