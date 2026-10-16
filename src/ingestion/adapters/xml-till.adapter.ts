import { Injectable } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import {
  fail,
  utcTimestampSchema,
  validateNewSale,
  type FieldError,
  type NewSale,
  type Result,
} from '../../canonical';
import type { PosFormatAdapter } from '../pos-format-adapter';
import { REPLACEMENT_CHAR, stripBom } from './text';

export const SUPPORTED_XML_SCHEMA_VERSIONS = ['1'] as const;

/**
 * Hardened parser config. Values stay strings (`parseTagValue: false`) so `000123` or
 * `8.30` are never coerced into numbers; amounts are converted with string arithmetic.
 * DTDs are rejected before this parser runs (see `rejectDtd`), so the entity handling
 * below only ever sees the five predefined XML entities and character references.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (_name, jpath) => String(jpath) === 'Sale.Lines.Line',
});

const text = z.string();
/** `<Quantity>18.5</Quantity>` without the attribute parses as a bare string; normalise it. */
const withAttributes = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? { '#text': v } : v), schema);

/** Wire shape after parsing: strict, so unknown elements and attributes are rejected. */
const xmlSaleV1 = z.strictObject({
  '@_schemaVersion': text,
  Merchant: text,
  Site: text,
  Terminal: text,
  Receipt: text,
  OccurredAt: text,
  Currency: text,
  Totals: z.strictObject({ Total: text, Tax: text }),
  Lines: z.strictObject({
    Line: z
      .array(
        z.strictObject({
          Sku: text,
          Description: text,
          Quantity: withAttributes(z.strictObject({ '#text': text, '@_unit': text })),
          UnitPrice: text,
          LineTotal: text,
          TaxRate: text,
        }),
      )
      .min(1),
  }),
  Payment: z.strictObject({ '@_method': text, Token: text, CardBrand: text.optional() }),
});
type XmlSaleV1 = z.infer<typeof xmlSaleV1>;

/** Legacy XML till document (docs/formats/xml.md). */
@Injectable()
export class XmlTillAdapter implements PosFormatAdapter {
  readonly format = 'xml';
  readonly mediaTypes = ['application/xml', 'text/xml'];

  looksLike(raw: Buffer): boolean {
    const head = raw.subarray(0, 64).toString('latin1');
    return /^(\xEF\xBB\xBF)?\s*</.test(head);
  }

  parse(raw: Buffer): Result<NewSale> {
    const decoded = decode(raw);
    if (!decoded.ok) return decoded;
    const xml = decoded.value;

    const dtd = rejectDtd(xml);
    if (dtd) return fail([dtd]);

    // fast-xml-parser's parse() tolerates mismatched tags, so well-formedness is checked first.
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      const { code, line, col } = validation.err;
      // The library's message can quote tag names from the input; report the code only.
      return fail([{ path: `line ${line}, col ${col}`, message: `malformed XML (${code})` }]);
    }

    let doc: unknown;
    try {
      doc = parser.parse(xml);
    } catch {
      // e.g. reserved names such as <__proto__>, which the library refuses by throwing
      return fail([{ path: '(document)', message: 'malformed or disallowed XML' }]);
    }

    const root = doc as Record<string, unknown>;
    const rootNames = Object.keys(root);
    if (rootNames.length !== 1 || rootNames[0] !== 'Sale') {
      return fail([
        {
          path: '/',
          message: `root element must be <Sale>; got ${rootNames.map((n) => `<${n}>`).join(', ') || 'none'}`,
        },
      ]);
    }

    const sale = root.Sale as Record<string, unknown> | string;
    const version = typeof sale === 'object' ? sale['@_schemaVersion'] : undefined;
    if (!SUPPORTED_XML_SCHEMA_VERSIONS.includes(version as never)) {
      return fail([
        {
          path: '/Sale/@schemaVersion',
          message: `unsupported schema version ${JSON.stringify(version ?? null)}; supported: ${SUPPORTED_XML_SCHEMA_VERSIONS.join(', ')}`,
        },
      ]);
    }

    const wire = xmlSaleV1.safeParse(sale);
    if (!wire.success) {
      return fail(
        wire.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys'
            ? issue.keys.map((key) => ({
                path: xmlPath([...issue.path, key]),
                message: 'unknown element or attribute',
              }))
            : [{ path: xmlPath(issue.path), message: issue.message }],
        ),
      );
    }

    const errors: FieldError[] = [];
    const canonical = toCanonical(wire.data, errors);
    if (errors.length > 0) return fail(errors);

    const validated = validateNewSale(canonical);
    return validated.ok
      ? validated
      : fail(validated.errors.map((e) => ({ ...e, path: canonicalToXmlPath(e.path) })));
  }
}

/** Honours the XML declaration's encoding: UTF-8 (default) or ISO-8859-1. */
function decode(raw: Buffer): Result<string> {
  if (raw.length === 0) return fail([{ path: '(document)', message: 'empty body' }]);
  const declared = /^(?:\xEF\xBB\xBF)?<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i
    .exec(raw.subarray(0, 200).toString('latin1'))?.[1]
    ?.toLowerCase();

  if (declared === 'iso-8859-1' || declared === 'latin1')
    return { ok: true, value: raw.toString('latin1') };
  if (declared !== undefined && declared !== 'utf-8' && declared !== 'utf8') {
    return fail([
      { path: '/?xml/@encoding', message: 'unsupported encoding; use UTF-8 or ISO-8859-1' },
    ]);
  }
  const utf8 = raw.toString('utf8');
  if (utf8.includes(REPLACEMENT_CHAR)) {
    return fail([
      {
        path: '(document)',
        message: 'not valid UTF-8; declare encoding="ISO-8859-1" if that is what is sent',
      },
    ]);
  }
  return { ok: true, value: stripBom(utf8) };
}

/**
 * XXE and entity-expansion ("billion laughs") attacks both need a DTD. Tills have no use
 * for one, so any DOCTYPE or ENTITY declaration is refused before parsing.
 */
function rejectDtd(xml: string): FieldError | undefined {
  return /<!(DOCTYPE|ENTITY)/i.test(xml)
    ? { path: '(document)', message: 'DOCTYPE and entity declarations are not allowed' }
    : undefined;
}

function toCanonical(s: XmlSaleV1, errors: FieldError[]): NewSale {
  const err = (path: string, message: string) => errors.push({ path, message });
  const currency = s.Currency;
  const exponent = minorUnitExponent(currency);

  const money = (value: string, path: string) => {
    const minor = decimalToInteger(value, exponent);
    if (minor === undefined)
      err(path, `must be a decimal amount with at most ${exponent} decimal places`);
    return minor ?? 0;
  };

  const lines = s.Lines.Line.map((line, i) => {
    const base = `/Sale/Lines/Line[${i + 1}]`;
    const quantity = line.Quantity['#text'];
    if (!/^\d+(\.\d{1,3})?$/.test(quantity))
      err(`${base}/Quantity`, 'must be a decimal with at most 3 decimal places');
    const taxRateBps = decimalToInteger(line.TaxRate, 2);
    if (taxRateBps === undefined)
      err(
        `${base}/TaxRate`,
        'must be a percentage with at most 2 decimal places, e.g. 23 or 23.00',
      );
    return {
      sku: line.Sku,
      description: line.Description,
      quantity: Number(quantity),
      unit: line.Quantity['@_unit'] as NewSale['lines'][number]['unit'],
      unitPriceMinor: money(line.UnitPrice, `${base}/UnitPrice`),
      lineTotalMinor: money(line.LineTotal, `${base}/LineTotal`),
      taxRateBps: taxRateBps ?? 0,
    };
  });

  return {
    merchantId: s.Merchant,
    siteId: s.Site,
    terminalId: s.Terminal,
    externalRef: s.Receipt,
    occurredAt: toUtc(s.OccurredAt),
    currency,
    totalMinor: money(s.Totals.Total, '/Sale/Totals/Total'),
    taxMinor: money(s.Totals.Tax, '/Sale/Totals/Tax'),
    lines,
    payment: {
      method: s.Payment['@_method'] as NewSale['payment']['method'],
      paymentToken: s.Payment.Token,
      ...(s.Payment.CardBrand ? { cardBrand: s.Payment.CardBrand } : {}),
    },
    source: { format: 'xml', schemaVersion: s['@_schemaVersion'] },
  };
}

/** ISO 4217 minor-unit digits: EUR 2, JPY 0, KWD 3. Unknown codes default to 2 (the canonical check rejects them). */
function minorUnitExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * `"8.3"` with 2 digits → 830. String arithmetic only: `Number("8.3") * 100` is 830.0000000000001.
 * More decimals than allowed is an error, never a silent rounding.
 */
export function decimalToInteger(value: string, digits: number): number | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return undefined;
  const [, whole, fraction = ''] = m;
  if (fraction.length > digits) return undefined;
  const result = Number(whole + fraction.padEnd(digits, '0'));
  return Number.isSafeInteger(result) ? result : undefined;
}

/**
 * Legacy tills may send an offset (`2026-10-15T15:30:00+01:00`); the meaning is clear, so it is
 * normalised to UTC. The date and time are validated as written first, because `Date` silently
 * rolls invalid values over (Feb 30 → Mar 2). Values without a zone are left as-is for the
 * canonical check to reject: local time is ambiguous.
 */
export function toUtc(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !utcTimestampSchema.safeParse(`${m[1]}Z`).success) return value;
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

/** zod path `['Lines','Line',0,'Quantity','@_unit']` → `/Sale/Lines/Line[1]/Quantity/@unit` */
function xmlPath(path: readonly PropertyKey[]): string {
  let out = '/Sale';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key + 1}]`;
    else if (key === '#text') continue;
    else if (String(key).startsWith('@_')) out += `/@${String(key).slice(2)}`;
    else out += `/${String(key)}`;
  }
  return out;
}

const CANONICAL_TO_XML: Record<string, string> = {
  merchantId: '/Sale/Merchant',
  siteId: '/Sale/Site',
  terminalId: '/Sale/Terminal',
  externalRef: '/Sale/Receipt',
  occurredAt: '/Sale/OccurredAt',
  currency: '/Sale/Currency',
  totalMinor: '/Sale/Totals/Total',
  taxMinor: '/Sale/Totals/Tax',
  'payment.method': '/Sale/Payment/@method',
  'payment.paymentToken': '/Sale/Payment/Token',
  'payment.cardBrand': '/Sale/Payment/CardBrand',
};

const LINE_FIELD_TO_XML: Record<string, string> = {
  sku: 'Sku',
  description: 'Description',
  quantity: 'Quantity',
  unit: 'Quantity/@unit',
  unitPriceMinor: 'UnitPrice',
  lineTotalMinor: 'LineTotal',
  taxRateBps: 'TaxRate',
};

function canonicalToXmlPath(path: string): string {
  const line = /^lines\[(\d+)\]\.(\w+)$/.exec(path);
  if (line) {
    const field = LINE_FIELD_TO_XML[line[2]!];
    return field ? `/Sale/Lines/Line[${Number(line[1]) + 1}]/${field}` : path;
  }
  return CANONICAL_TO_XML[path] ?? path;
}
