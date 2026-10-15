import { z } from 'zod';
import {
  currencySchema,
  metadataSchema,
  paymentTokenSchema,
  utcTimestampSchema,
} from '../../canonical/transaction.schema';

/**
 * Public wire contract for JSON tills, version 1. Deliberately separate from the
 * canonical model: internal changes must not silently change what tills may send.
 * Strict: unknown fields are rejected so typos (`totalMnior`) fail loudly.
 */
const id = z.string().trim().min(1).max(64);
const minorUnits = z.int().nonnegative();

export const jsonSaleLineV1 = z.strictObject({
  sku: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().positive(),
  unit: z.enum(['ITEM', 'KWH', 'MINUTE', 'LITRE']),
  unitPriceMinor: minorUnits,
  lineTotalMinor: minorUnits,
  taxRateBps: z.int().min(0).max(10_000),
});

export const jsonSaleV1 = z.strictObject({
  schemaVersion: z.literal('1'),
  merchantId: id,
  siteId: id,
  terminalId: id,
  externalRef: id,
  occurredAt: utcTimestampSchema,
  currency: currencySchema,
  totalMinor: minorUnits,
  taxMinor: minorUnits,
  lines: z.array(jsonSaleLineV1).min(1).max(500),
  payment: z.strictObject({
    method: z.enum(['CARD', 'WALLET', 'FLEET_CARD']),
    paymentToken: paymentTokenSchema,
    cardBrand: z.string().optional(),
  }),
  metadata: metadataSchema.optional(),
});

export type JsonSaleV1 = z.infer<typeof jsonSaleV1>;

export const SUPPORTED_JSON_SCHEMA_VERSIONS = ['1'] as const;
