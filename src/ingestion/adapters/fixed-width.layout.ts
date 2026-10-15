/**
 * Column layout of the legacy fixed-width format, layout version 01.
 * Single source of truth: the parser reads it and docs/formats/fixed-width.md is generated from it.
 * Positions are 1-based, inclusive, in BYTES (the format is ISO-8859-1: one byte per character).
 */
export const RECORD_LENGTH = 80;
export const LAYOUT_VERSION = '01';

export type FieldKind =
  | 'type' // the record type letter
  | 'text' // required, left-justified, space-padded
  | 'optional-text' // may be all spaces
  | 'digits' // zero-padded unsigned integer
  | 'code' // single-letter code from a fixed set
  | 'reserved'; // must be spaces

export interface FieldSpec {
  name: string;
  start: number;
  length: number;
  kind: FieldKind;
  description: string;
}

export type RecordType = 'H' | 'L' | 'P' | 'T';

export interface RecordSpec {
  type: RecordType;
  title: string;
  fields: FieldSpec[];
}

const f = (
  name: string,
  start: number,
  length: number,
  kind: FieldKind,
  description: string,
): FieldSpec => ({
  name,
  start,
  length,
  kind,
  description,
});

export const UNIT_CODES = { I: 'ITEM', K: 'KWH', M: 'MINUTE', L: 'LITRE' } as const;
export const METHOD_CODES = { C: 'CARD', W: 'WALLET', F: 'FLEET_CARD' } as const;

/** Quantity has 3 implied decimals: `0000018500` = 18.500. */
export const QUANTITY_IMPLIED_DECIMALS = 3;

export const LAYOUT: Record<RecordType, RecordSpec> = {
  H: {
    type: 'H',
    title: 'Header (exactly one, first record)',
    fields: [
      f('recordType', 1, 1, 'type', '`H`'),
      f('layoutVersion', 2, 2, 'digits', '`01`'),
      f('merchantId', 4, 12, 'text', 'Merchant id'),
      f('siteId', 16, 12, 'text', 'Site id (parking site, charging station)'),
      f('terminalId', 28, 12, 'text', 'Till id'),
      f('occurredAt', 40, 16, 'text', 'UTC timestamp `YYYYMMDDTHHMMSSZ`'),
      f('currency', 56, 3, 'text', 'ISO 4217 code, e.g. `EUR`'),
      f('externalRef', 59, 20, 'text', 'Receipt / sale number'),
      f('reserved', 79, 2, 'reserved', 'Spaces'),
    ],
  },
  L: {
    type: 'L',
    title: 'Line (one or more, after the header)',
    fields: [
      f('recordType', 1, 1, 'type', '`L`'),
      f('sku', 2, 12, 'text', 'Product code, e.g. `EV-KWH`'),
      f('description', 14, 30, 'text', 'Description (ISO-8859-1)'),
      f('quantity', 44, 10, 'digits', 'Quantity, 3 implied decimals: `0000018500` = 18.5'),
      f('unit', 54, 1, 'code', '`I` item, `K` kWh, `M` minute, `L` litre'),
      f('unitPriceMinor', 55, 9, 'digits', 'Gross unit price in minor units'),
      f('lineTotalMinor', 64, 9, 'digits', 'Gross line total in minor units, as printed'),
      f('taxRateBps', 73, 5, 'digits', 'Tax rate in basis points: `02300` = 23%'),
      f('reserved', 78, 3, 'reserved', 'Spaces'),
    ],
  },
  P: {
    type: 'P',
    title: 'Payment (exactly one, after the lines)',
    fields: [
      f('recordType', 1, 1, 'type', '`P`'),
      f('method', 2, 1, 'code', '`C` card, `W` wallet, `F` fleet card'),
      f('paymentToken', 3, 68, 'text', 'Provider token `tok_…` (never a card number)'),
      f('cardBrand', 71, 10, 'optional-text', 'Card brand, e.g. `VISA`, or spaces'),
    ],
  },
  T: {
    type: 'T',
    title: 'Trailer (exactly one, last record)',
    fields: [
      f('recordType', 1, 1, 'type', '`T`'),
      f('lineCount', 2, 4, 'digits', 'Number of `L` records'),
      f('totalMinor', 6, 11, 'digits', 'Gross total in minor units'),
      f('taxMinor', 17, 11, 'digits', 'Tax contained in the total, minor units'),
      f('reserved', 28, 53, 'reserved', 'Spaces'),
    ],
  },
};

export function fieldEnd(field: FieldSpec): number {
  return field.start + field.length - 1;
}
