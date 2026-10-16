import type { Knex } from 'knex';
import { freshDatabase, pgError } from '../../test/support/database';
import { uuidv7 } from './uuidv7';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

let db: Knex;

const transaction = (overrides: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  merchant_id: 'MERCH01',
  site_id: 'SITE042',
  terminal_id: 'TERM0001',
  external_ref: `R${Math.random().toString().slice(2, 10)}`,
  occurred_at: '2026-10-15T14:30:00Z',
  currency: 'EUR',
  total_minor: 1132,
  tax_minor: 212,
  payment_method: 'CARD',
  payment_token: 'tok_8f3kD92LmQ',
  source_format: 'json',
  source_schema_version: '1',
  ...overrides,
});

const line = (transactionId: string, lineNo = 1) => ({
  transaction_id: transactionId,
  line_no: lineNo,
  sku: 'EV-KWH',
  description: 'DC fast charge',
  quantity: '18.500',
  unit: 'KWH',
  unit_price_minor: 45,
  line_total_minor: 832,
  tax_rate_bps: 2300,
});

beforeAll(async () => {
  db = await freshDatabase();
  await db.migrate.latest();
});

afterAll(async () => {
  await db.destroy();
});

describe('migrations', () => {
  it('roll back completely and apply again on a clean database', async () => {
    await db.migrate.latest();
    await db.migrate.rollback(undefined, true);
    const { rows } = await db.raw<{ rows: unknown[] }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_%'`,
    );
    expect(rows).toEqual([]);

    await db.migrate.latest();
    const [, pending] = (await db.migrate.list()) as [unknown[], string[]];
    expect(pending).toEqual([]);
  });
});

describe('transactions', () => {
  it('stores a sale with its lines and defaults to PENDING', async () => {
    const tx = transaction();
    await db('transactions').insert(tx);
    await db('transaction_lines').insert([line(tx.id, 1), line(tx.id, 2)]);

    const stored = await db('transactions')
      .where({ id: tx.id })
      .first<{ status: string; total_minor: string }>();
    expect(stored.status).toBe('PENDING');
    // node-postgres returns bigint as a string: it can exceed Number.MAX_SAFE_INTEGER
    expect(stored.total_minor).toBe('1132');
  });

  it('rejects the same receipt twice from the same till', async () => {
    const first = transaction();
    await db('transactions').insert(first);
    const duplicate = transaction({ external_ref: first.external_ref });
    expect(await pgError(db('transactions').insert(duplicate))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'transactions_sale_once',
    });
  });

  it('allows the same terminal id and receipt number at a different merchant', async () => {
    const first = transaction({ external_ref: 'R-SHARED' });
    await db('transactions').insert(first);
    await expect(
      db('transactions').insert(transaction({ external_ref: 'R-SHARED', merchant_id: 'MERCH02' })),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      'a card number as the token',
      { payment_token: '4111111111111111' },
      'transactions_payment_token_check',
    ],
    ['tax above the total', { tax_minor: 2000 }, 'transactions_tax_within_total'],
    ['an unknown status', { status: 'REFUNDED' }, 'transactions_status_check'],
    ['a zero total', { total_minor: 0, tax_minor: 0 }, 'transactions_total_minor_check'],
    ['a lowercase currency', { currency: 'eur' }, 'transactions_currency_check'],
    [
      'FAILED without a reason',
      { status: 'FAILED' },
      'transactions_failure_reason_only_when_failed',
    ],
    [
      'a reason without FAILED',
      { failure_reason: 'declined' },
      'transactions_failure_reason_only_when_failed',
    ],
  ])('rejects %s', async (_name, overrides, constraint) => {
    expect(await pgError(db('transactions').insert(transaction(overrides)))).toEqual({
      code: CHECK_VIOLATION,
      constraint,
    });
  });

  it('maintains updated_at on every update', async () => {
    const tx = transaction();
    await db('transactions').insert(tx);
    const before = await db('transactions').where({ id: tx.id }).first<{ updated_at: Date }>();
    await db('transactions').where({ id: tx.id }).update({ status: 'AUTHORIZED' });
    const after = await db('transactions').where({ id: tx.id }).first<{ updated_at: Date }>();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('deletes lines with their transaction and rejects orphan lines', async () => {
    const tx = transaction();
    await db('transactions').insert(tx);
    await db('transaction_lines').insert(line(tx.id));
    await db('transactions').where({ id: tx.id }).delete();
    expect(await db('transaction_lines').where({ transaction_id: tx.id })).toEqual([]);

    expect((await pgError(db('transaction_lines').insert(line(uuidv7())))).code).toBe(FK_VIOLATION);
  });

  it('keeps quantities exact (numeric, not float)', async () => {
    const tx = transaction();
    await db('transactions').insert(tx);
    await db('transaction_lines').insert({ ...line(tx.id), quantity: '42.370' });
    const stored = await db('transaction_lines')
      .where({ transaction_id: tx.id })
      .first<{ quantity: string }>();
    expect(stored.quantity).toBe('42.370');
  });
});

describe('idempotency_keys', () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    merchant_id: 'MERCH01',
    idempotency_key: '6f1c2b8e-1d5a-4a7e-9b1e-2f0c3d4e5a6b',
    request_fingerprint: 'a'.repeat(64),
    state: 'IN_PROGRESS',
    locked_until: db.raw(`now() + interval '30 seconds'`),
    expires_at: db.raw(`now() + interval '24 hours'`),
    ...overrides,
  });

  it('lets exactly one claim win with INSERT ... ON CONFLICT DO NOTHING', async () => {
    const claim = () =>
      db('idempotency_keys')
        .insert(key({ idempotency_key: 'race-1' }))
        .onConflict(['merchant_id', 'idempotency_key'])
        .ignore()
        .returning('idempotency_key');
    const results = await Promise.all([claim(), claim(), claim(), claim(), claim()]);
    expect(results.map((rows) => rows.length).sort()).toEqual([0, 0, 0, 0, 1]);
  });

  it('scopes keys per merchant', async () => {
    await db('idempotency_keys').insert(key({ idempotency_key: 'shared' }));
    await expect(
      db('idempotency_keys').insert(key({ idempotency_key: 'shared', merchant_id: 'MERCH02' })),
    ).resolves.toBeDefined();
  });

  it.each([
    ['COMPLETED without a stored response', { state: 'COMPLETED', locked_until: null }],
    ['IN_PROGRESS without a lock expiry', { locked_until: null }],
    ['IN_PROGRESS with a stored response', { response_status: 201 }],
  ])('rejects %s', async (_name, overrides) => {
    expect(
      await pgError(
        db('idempotency_keys').insert(key({ idempotency_key: `bad-${_name}`, ...overrides })),
      ),
    ).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'idempotency_keys_state_consistent',
    });
  });
});

describe('outbox', () => {
  it('assigns increasing ids in insertion order', async () => {
    const insert = () =>
      db('outbox')
        .insert({
          event_id: uuidv7(),
          aggregate_id: uuidv7(),
          event_type: 'transaction.authorized',
          payload: {},
        })
        .returning<{ id: string }[]>('id');
    const [[a], [b]] = [await insert(), await insert()];
    expect(BigInt(b!.id)).toBeGreaterThan(BigInt(a!.id));
  });

  it('rejects a duplicate event_id', async () => {
    const eventId = uuidv7();
    const row = {
      event_id: eventId,
      aggregate_id: uuidv7(),
      event_type: 'transaction.captured',
      payload: {},
    };
    await db('outbox').insert(row);
    expect((await pgError(db('outbox').insert(row))).code).toBe(UNIQUE_VIOLATION);
  });
});
