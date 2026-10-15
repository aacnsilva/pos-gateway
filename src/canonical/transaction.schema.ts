import { z } from 'zod';

/** Max decimals for a quantity: the legacy fixed-width format carries 3 implied decimals. */
export const QUANTITY_SCALE = 1000;

const ISO_4217 = new Set(Intl.supportedValuesOf('currency'));

/** Money is always an integer number of minor units (cents). Floats are rejected outright. */
const minorUnits = z.int().nonnegative();

const nonBlank = (max: number) => z.string().trim().min(1).max(max);

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase ISO 4217 code')
  .refine((code) => ISO_4217.has(code), 'unknown ISO 4217 currency');

/** UTC only: `2026-10-15T14:30:00Z`. Offsets like `+01:00` are rejected so storage is unambiguous. */
export const utcTimestampSchema = z.iso.datetime({
  message: 'must be an ISO 8601 UTC timestamp ending in Z',
});

/**
 * Provider-issued payment token. The fixed `tok_` prefix means a raw card number can
 * never pass as a token. There is deliberately no field that could hold a PAN.
 */
export const paymentTokenSchema = z
  .string()
  .regex(/^tok_[A-Za-z0-9]{8,64}$/, 'must be a provider token (tok_ + 8-64 alphanumerics)');

export const transactionLineSchema = z.strictObject({
  sku: nonBlank(32),
  description: nonBlank(200),
  quantity: z
    .number()
    .positive()
    .refine((q) => hasAtMostDecimals(q, 3), 'at most 3 decimal places'),
  unit: z.enum(['ITEM', 'KWH', 'MINUTE', 'LITRE']),
  /** Gross (tax-inclusive) price per unit, as shown to the customer. */
  unitPriceMinor: minorUnits,
  /** Gross line amount as printed on the till receipt. The till owns rounding. */
  lineTotalMinor: minorUnits,
  /** Basis points: 2300 = 23%. */
  taxRateBps: z.int().min(0).max(10_000),
});

export const paymentSchema = z.strictObject({
  method: z.enum(['CARD', 'WALLET', 'FLEET_CARD']),
  paymentToken: paymentTokenSchema,
  cardBrand: z
    .string()
    .regex(/^[A-Z_]{2,20}$/)
    .optional(),
});

export const sourceSchema = z.strictObject({
  format: z.enum(['json', 'fixed-width', 'xml']),
  schemaVersion: nonBlank(20),
});

/**
 * What an ingestion adapter produces: a validated sale, not yet persisted.
 * `id` and `status` are assigned by the gateway, never by a till.
 */
export const newSaleSchema = z
  .strictObject({
    merchantId: nonBlank(64),
    siteId: nonBlank(64),
    terminalId: nonBlank(64),
    externalRef: nonBlank(64),
    occurredAt: utcTimestampSchema,
    currency: currencySchema,
    /** Gross total (incl. tax) to charge; must equal the sum of `lineTotalMinor`. */
    totalMinor: minorUnits.positive(),
    /** Tax contained in `totalMinor`, as computed by the till. */
    taxMinor: minorUnits,
    lines: z.array(transactionLineSchema).min(1).max(500),
    payment: paymentSchema,
    source: sourceSchema,
  })
  .superRefine((sale, ctx) => {
    sale.lines.forEach((line, i) => {
      if (!lineTotalMatchesPrice(line.quantity, line.unitPriceMinor, line.lineTotalMinor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'lineTotalMinor'],
          message: `does not match quantity × unitPriceMinor (${line.quantity} × ${line.unitPriceMinor}) within 1 minor unit`,
        });
      }
    });

    const sumOfLines = sale.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (sumOfLines !== sale.totalMinor) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalMinor'],
        message: `must equal the sum of lineTotalMinor (${sumOfLines})`,
      });
    }

    if (sale.taxMinor > sale.totalMinor) {
      ctx.addIssue({
        code: 'custom',
        path: ['taxMinor'],
        message: 'cannot exceed totalMinor',
      });
    }
  });

export const transactionStatusSchema = z.enum(['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED']);

export const transactionSchema = newSaleSchema.and(
  z.object({ id: z.uuid(), status: transactionStatusSchema }),
);

export type NewSale = z.infer<typeof newSaleSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionLine = z.infer<typeof transactionLineSchema>;
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

function hasAtMostDecimals(value: number, decimals: number): boolean {
  const [, fraction = ''] = String(value).split('.');
  return !String(value).includes('e') && fraction.length <= decimals;
}

/**
 * Sanity check, not a recalculation: the till's rounding is accepted as long as the line
 * total is within 1 minor unit of quantity × unit price. This catches parser bugs such as
 * shifted columns or a misplaced implied decimal without second-guessing the till.
 * Uses integer arithmetic (quantity scaled to thousandths) to avoid float drift.
 */
export function lineTotalMatchesPrice(
  quantity: number,
  unitPriceMinor: number,
  lineTotalMinor: number,
): boolean {
  const quantityMilli = Math.round(quantity * QUANTITY_SCALE);
  const exactTimesScale = quantityMilli * unitPriceMinor;
  return Math.abs(exactTimesScale - lineTotalMinor * QUANTITY_SCALE) < QUANTITY_SCALE;
}
