import { lineTotalMatchesPrice, type NewSale } from './transaction.schema';
import { validateNewSale } from './validate';

/** EV charging: 18.5 kWh at €0.45/kWh (gross) = 832.5c, till rounds to 832c; 23% VAT included. */
const evSale = (): NewSale => ({
  merchantId: 'MERCH01',
  siteId: 'SITE042',
  terminalId: 'TERM0001',
  externalRef: 'R000123',
  occurredAt: '2026-10-15T14:30:00Z',
  currency: 'EUR',
  totalMinor: 1132,
  taxMinor: 212,
  lines: [
    {
      sku: 'EV-KWH',
      description: 'DC fast charge',
      quantity: 18.5,
      unit: 'KWH',
      unitPriceMinor: 45,
      lineTotalMinor: 832,
      taxRateBps: 2300,
    },
    {
      sku: 'PARKING-MIN',
      description: 'Parking while charging',
      quantity: 60,
      unit: 'MINUTE',
      unitPriceMinor: 5,
      lineTotalMinor: 300,
      taxRateBps: 2300,
    },
  ],
  payment: { method: 'CARD', paymentToken: 'tok_8f3kD92LmQ', cardBrand: 'VISA' },
  source: { format: 'json', schemaVersion: '1' },
});

function errorsFor(input: unknown) {
  const result = validateNewSale(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

describe('validateNewSale', () => {
  it('accepts a valid sale', () => {
    const result = validateNewSale(evSale());
    expect(result).toEqual({ ok: true, value: evSale() });
  });

  describe('money', () => {
    it('rejects floats in money fields', () => {
      const sale = { ...evSale(), totalMinor: 11.32 };
      expect(errorsFor(sale)).toContainEqual(expect.objectContaining({ path: 'totalMinor' }));
    });

    it('rejects money as a string', () => {
      const sale = evSale();
      expect(
        errorsFor({ ...sale, lines: [{ ...sale.lines[0], unitPriceMinor: '45' }] }),
      ).toContainEqual(expect.objectContaining({ path: 'lines[0].unitPriceMinor' }));
    });

    it('rejects negative amounts', () => {
      expect(errorsFor({ ...evSale(), taxMinor: -1 })).toContainEqual(
        expect.objectContaining({ path: 'taxMinor' }),
      );
    });

    it('rejects a total that differs from the sum of line totals', () => {
      expect(errorsFor({ ...evSale(), totalMinor: 1133 })).toEqual([
        { path: 'totalMinor', message: 'must equal the sum of lineTotalMinor (1132)' },
      ]);
    });

    it('rejects tax greater than the total', () => {
      expect(errorsFor({ ...evSale(), taxMinor: 2000 })).toEqual([
        { path: 'taxMinor', message: 'cannot exceed totalMinor' },
      ]);
    });

    it('rejects a line total that does not match quantity × unit price', () => {
      const sale = evSale();
      // e.g. a fixed-width parser that misplaced the implied decimal: 185 kWh instead of 18.5
      sale.lines[0]!.quantity = 185;
      expect(errorsFor(sale)).toContainEqual(
        expect.objectContaining({ path: 'lines[0].lineTotalMinor' }),
      );
    });
  });

  describe('lineTotalMatchesPrice (till rounding tolerance)', () => {
    it.each([
      [18.5, 45, 832, true], // 832.5 rounded down
      [18.5, 45, 833, true], // 832.5 rounded up
      [18.5, 45, 831, false],
      [18.5, 45, 834, false],
      [3, 199, 597, true], // exact
      [3, 199, 598, false], // exact amounts allow no drift
      [0.1, 3, 0, true], // 0.3c
      [1.005, 1000, 1005, true], // would drift with naive float math
    ])('%d × %d → %d is %s', (quantity, unitPrice, lineTotal, expected) => {
      expect(lineTotalMatchesPrice(quantity, unitPrice, lineTotal)).toBe(expected);
    });
  });

  describe('quantity', () => {
    it.each([0, -1, 1.2345])('rejects %d', (quantity) => {
      const sale = evSale();
      sale.lines[0]!.quantity = quantity;
      expect(errorsFor(sale)).toContainEqual(
        expect.objectContaining({ path: 'lines[0].quantity' }),
      );
    });
  });

  describe('currency', () => {
    it.each(['XYZ', 'eur', 'EURO', ''])('rejects %p', (currency) => {
      expect(errorsFor({ ...evSale(), currency })).toContainEqual(
        expect.objectContaining({ path: 'currency' }),
      );
    });
  });

  describe('timestamps', () => {
    it.each([
      '2026-10-15T15:30:00+01:00', // offset, not UTC
      '2026-10-15T14:30:00', // no zone at all
      '2026-10-15', // date only
      '15/10/2026 14:30', // not ISO 8601
    ])('rejects %p', (occurredAt) => {
      expect(errorsFor({ ...evSale(), occurredAt })).toContainEqual(
        expect.objectContaining({ path: 'occurredAt' }),
      );
    });

    it('accepts fractional seconds in UTC', () => {
      expect(validateNewSale({ ...evSale(), occurredAt: '2026-10-15T14:30:00.123Z' }).ok).toBe(
        true,
      );
    });
  });

  describe('payment holds a token only', () => {
    it('rejects an extra pan field', () => {
      const sale = evSale();
      const payment = { ...sale.payment, pan: '4111111111111111' };
      expect(errorsFor({ ...sale, payment })).toContainEqual({
        path: 'payment.pan',
        message: 'unknown field',
      });
    });

    it('rejects a card number passed as the token', () => {
      const sale = evSale();
      const payment = { ...sale.payment, paymentToken: '4111111111111111' };
      expect(errorsFor({ ...sale, payment })).toContainEqual(
        expect.objectContaining({ path: 'payment.paymentToken' }),
      );
    });
  });

  describe('structure', () => {
    it('rejects a sale with no lines', () => {
      expect(errorsFor({ ...evSale(), lines: [] })).toContainEqual(
        expect.objectContaining({ path: 'lines' }),
      );
    });

    it('rejects gateway-owned fields coming from a till', () => {
      expect(errorsFor({ ...evSale(), id: 'x', status: 'CAPTURED' })).toEqual([
        { path: 'id', message: 'unknown field' },
        { path: 'status', message: 'unknown field' },
      ]);
    });

    it('reports every missing field, not just the first', () => {
      const paths = errorsFor({}).map((e) => e.path);
      expect(paths).toEqual(
        expect.arrayContaining(['merchantId', 'occurredAt', 'currency', 'lines', 'payment']),
      );
    });

    it('does not throw on non-object input', () => {
      expect(validateNewSale(null).ok).toBe(false);
      expect(validateNewSale('H|TERM0001').ok).toBe(false);
    });
  });
});
