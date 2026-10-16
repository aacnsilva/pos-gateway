import { Injectable } from '@nestjs/common';
import { fail, validateNewSale, type FieldError, type NewSale, type Result } from '../../canonical';
import type { PosFormatAdapter } from '../pos-format-adapter';
import {
  fieldEnd,
  LAYOUT,
  LAYOUT_VERSION,
  METHOD_CODES,
  QUANTITY_IMPLIED_DECIMALS,
  RECORD_LENGTH,
  UNIT_CODES,
  type FieldSpec,
  type RecordSpec,
  type RecordType,
} from './fixed-width.layout';
import { REPLACEMENT_CHAR } from './text';

type Fields = Record<string, string>;

interface ParsedRecord {
  /** 1-based position in the file, used in every error. */
  number: number;
  type: RecordType;
  fields: Fields;
}

/** Bytes that never belong in a record: C0 controls (incl. tab) and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/** Legacy column-positioned till format (docs/formats/fixed-width.md). ISO-8859-1, byte columns. */
@Injectable()
export class FixedWidthTillAdapter implements PosFormatAdapter {
  readonly format = 'fixed-width';
  readonly mediaTypes = ['text/x-fixed-width', 'text/plain'];

  looksLike(raw: Buffer): boolean {
    return raw.subarray(0, 3).toString('latin1') === `H${LAYOUT_VERSION}`;
  }

  parse(raw: Buffer): Result<NewSale> {
    const lines = splitRecords(raw);
    if (lines.length === 0) return fail([{ path: '(file)', message: 'empty body' }]);

    const errors: FieldError[] = [];
    const records: ParsedRecord[] = [];
    lines.forEach((line, i) => {
      const record = readRecord(line, i + 1, errors);
      if (record) records.push(record);
    });
    if (errors.length > 0) return fail(errors);

    const structure = checkStructure(records);
    if (!structure.ok) return structure;
    const { header, lines: lineRecords, payment, trailer } = structure.value;

    const sale = toCanonical(header, lineRecords, payment, trailer, errors);
    if (errors.length > 0 || !sale) return fail(errors);

    const validated = validateNewSale(sale);
    return validated.ok
      ? validated
      : fail(validated.errors.map((e) => toSourceLocation(e, structure.value)));
  }
}

/**
 * Splits on LF, dropping a CR before it (CRLF and LF both accepted). Trailing empty
 * lines are ignored; a blank line in the middle is kept so it is reported.
 */
function splitRecords(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === 0x0a) {
      let end = i;
      if (end > start && raw[end - 1] === 0x0d) end--;
      lines.push(raw.subarray(start, end));
      start = i + 1;
    }
  }
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}

function readRecord(line: Buffer, number: number, errors: FieldError[]): ParsedRecord | undefined {
  const text = line.toString('latin1'); // 1 byte = 1 char, so string offsets are byte offsets
  const type = text[0] as RecordType | undefined;
  const spec = type ? LAYOUT[type] : undefined;
  if (!spec) {
    errors.push({
      path: `record ${number}`,
      message: `unknown record type ${JSON.stringify(type ?? '')}`,
    });
    return undefined;
  }

  // Checked first: a UTF-8 "é" adds a byte, and the extra trailing space it pushes past
  // column 80 would otherwise be trimmed below, leaving silently shifted fields.
  if (text.length !== RECORD_LENGTH && looksUtf8(line)) {
    errors.push({
      path: `record ${number} [${type}]`,
      message: `record is ${text.length} bytes, expected ${RECORD_LENGTH}; it looks UTF-8 encoded, but this format is ISO-8859-1`,
    });
    return undefined;
  }

  // Extra trailing spaces (an editor or transport padding) are harmless; anything else is not.
  const record =
    text.length > RECORD_LENGTH && text.slice(RECORD_LENGTH).trim() === ''
      ? text.slice(0, RECORD_LENGTH)
      : text;
  if (record.length !== RECORD_LENGTH) {
    errors.push({
      path: `record ${number} [${type}]`,
      message: `record is ${record.length} bytes, expected ${RECORD_LENGTH}`,
    });
    return undefined;
  }
  if (CONTROL_CHARS.test(record)) {
    const col = record.search(CONTROL_CHARS) + 1;
    errors.push({
      path: `record ${number} [${type}] col ${col}`,
      message: 'control character not allowed',
    });
    return undefined;
  }

  const fields: Fields = {};
  for (const field of spec.fields) {
    const value = record.slice(field.start - 1, fieldEnd(field));
    const problem = checkField(field, value);
    if (problem) errors.push({ path: location(number, spec, field), message: problem });
    fields[field.name] = value.trim();
  }
  return { number, type: spec.type, fields };
}

/**
 * Valid multi-byte UTF-8 that fits the record once decoded. ISO-8859-1 accents are single
 * high bytes, which are invalid UTF-8 on their own, so real Latin-1 text doesn't match.
 */
function looksUtf8(line: Buffer): boolean {
  const asUtf8 = line.toString('utf8');
  return (
    /[\u0080-\uffff]/.test(asUtf8) &&
    !asUtf8.includes(REPLACEMENT_CHAR) &&
    asUtf8.trimEnd().length <= RECORD_LENGTH
  );
}

function checkField(field: FieldSpec, value: string): string | undefined {
  switch (field.kind) {
    case 'type':
    case 'optional-text':
      return undefined;
    case 'text':
      if (value.trim() === '') return 'required';
      if (value.startsWith(' ')) return 'must be left-justified';
      return undefined;
    case 'digits':
      return /^\d+$/.test(value) ? undefined : `must be ${field.length} digits, zero-padded`;
    case 'code':
      return value.trim() === '' ? 'required' : undefined;
    case 'reserved':
      return value.trim() === ''
        ? undefined
        : 'reserved, must be spaces (are the columns shifted?)';
  }
}

interface Structure {
  header: ParsedRecord;
  lines: ParsedRecord[];
  payment: ParsedRecord;
  trailer: ParsedRecord;
}

/** Expected order: H, L (one or more), P, T. */
function checkStructure(records: ParsedRecord[]): Result<Structure> {
  const order = records.map((r) => r.type).join('');
  if (!/^HL+PT$/.test(order)) {
    return fail([
      {
        path: '(file)',
        message: `records must be H, L (one or more), P, T in that order; got ${order}`,
      },
    ]);
  }
  return {
    ok: true,
    value: {
      header: records[0]!,
      lines: records.slice(1, -2),
      payment: records[records.length - 2]!,
      trailer: records[records.length - 1]!,
    },
  };
}

function toCanonical(
  header: ParsedRecord,
  lines: ParsedRecord[],
  payment: ParsedRecord,
  trailer: ParsedRecord,
  errors: FieldError[],
): NewSale | undefined {
  const h = header.fields;
  const err = (record: ParsedRecord, name: string, message: string) => {
    const spec = LAYOUT[record.type];
    const field = spec.fields.find((x) => x.name === name)!;
    errors.push({ path: location(record.number, spec, field), message });
  };

  if (h.layoutVersion !== LAYOUT_VERSION)
    err(header, 'layoutVersion', `unsupported layout version; supported: ${LAYOUT_VERSION}`);

  const lineCount = Number(trailer.fields.lineCount);
  if (lineCount !== lines.length)
    err(trailer, 'lineCount', `says ${lineCount} lines but the file has ${lines.length}`);

  const method = METHOD_CODES[payment.fields.method as keyof typeof METHOD_CODES];
  if (!method)
    err(
      payment,
      'method',
      `unknown method code; expected one of ${Object.keys(METHOD_CODES).join(', ')}`,
    );

  const canonicalLines = lines.map((line) => {
    const l = line.fields;
    const unit = UNIT_CODES[l.unit as keyof typeof UNIT_CODES];
    if (!unit)
      err(line, 'unit', `unknown unit code; expected one of ${Object.keys(UNIT_CODES).join(', ')}`);
    return {
      sku: l.sku!,
      description: l.description!,
      quantity: Number(l.quantity) / 10 ** QUANTITY_IMPLIED_DECIMALS,
      unit: unit ?? 'ITEM',
      unitPriceMinor: Number(l.unitPriceMinor),
      lineTotalMinor: Number(l.lineTotalMinor),
      taxRateBps: Number(l.taxRateBps),
    };
  });

  if (errors.length > 0 || !method) return undefined;

  return {
    merchantId: h.merchantId!,
    siteId: h.siteId!,
    terminalId: h.terminalId!,
    externalRef: h.externalRef!,
    occurredAt: toIsoUtc(h.occurredAt!),
    currency: h.currency!,
    totalMinor: Number(trailer.fields.totalMinor),
    taxMinor: Number(trailer.fields.taxMinor),
    lines: canonicalLines,
    payment: {
      method,
      paymentToken: payment.fields.paymentToken!,
      ...(payment.fields.cardBrand ? { cardBrand: payment.fields.cardBrand } : {}),
    },
    source: { format: 'fixed-width', schemaVersion: h.layoutVersion! },
  };
}

/** `20261015T143000Z` → `2026-10-15T14:30:00Z`. Anything else is passed through for the canonical check to reject. */
function toIsoUtc(compact: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(compact);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : compact;
}

function location(recordNumber: number, spec: RecordSpec, field: FieldSpec): string {
  const cols = field.length === 1 ? `col ${field.start}` : `cols ${field.start}-${fieldEnd(field)}`;
  return `record ${recordNumber} [${spec.type}] ${cols} ${field.name}`;
}

/** Canonical paths (`lines[1].quantity`, `totalMinor`) → the record and columns the till wrote. */
const CANONICAL_TO_RECORD: Record<string, 'header' | 'payment' | 'trailer'> = {
  merchantId: 'header',
  siteId: 'header',
  terminalId: 'header',
  externalRef: 'header',
  occurredAt: 'header',
  currency: 'header',
  totalMinor: 'trailer',
  taxMinor: 'trailer',
  'payment.method': 'payment',
  'payment.paymentToken': 'payment',
  'payment.cardBrand': 'payment',
};

function toSourceLocation(error: FieldError, s: Structure): FieldError {
  const lineMatch = /^lines\[(\d+)\]\.(\w+)$/.exec(error.path);
  const [record, name] = lineMatch
    ? [s.lines[Number(lineMatch[1])], lineMatch[2]!]
    : [
        CANONICAL_TO_RECORD[error.path] && s[CANONICAL_TO_RECORD[error.path]!],
        error.path.replace(/^payment\./, ''),
      ];
  const spec = record && LAYOUT[record.type];
  const field = spec?.fields.find((x) => x.name === name);
  return record && spec && field
    ? { path: location(record.number, spec, field), message: error.message }
    : error;
}
