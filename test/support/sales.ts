import type { NewSale } from '../../src/canonical';

/** A minimal valid sale (single parking line) for tests that don't care about the details. */
export const parkingSale = (): Omit<NewSale, 'source'> => ({
  merchantId: 'MERCH01',
  siteId: 'SITE042',
  terminalId: 'TERM0001',
  externalRef: 'R000124',
  occurredAt: '2026-10-15T09:00:00Z',
  currency: 'EUR',
  totalMinor: 300,
  taxMinor: 56,
  lines: [
    {
      sku: 'PARKING-MIN',
      description: 'Parking',
      quantity: 60,
      unit: 'MINUTE',
      unitPriceMinor: 5,
      lineTotalMinor: 300,
      taxRateBps: 2300,
    },
  ],
  payment: { method: 'CARD', paymentToken: 'tok_8f3kD92LmQ' },
});
