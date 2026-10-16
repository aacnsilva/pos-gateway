# Database: schema, constraints and indexes

PostgreSQL 16. One migration so far: `src/database/migrations/0001_initial_schema.ts` (plain SQL run through Knex).

```bash
export DATABASE_URL=postgres://postgres@localhost:5432/pos_gateway
npm run db:migrate     # apply pending migrations
npm run db:status      # list applied / pending
npm run db:rollback    # revert the last batch

# schema tests against a real PostgreSQL (the database is wiped)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/pos_gateway_test npm run test:db
```

Migrations are listed in code (`src/database/migrations/index.ts`) rather than discovered from a folder, so the same list runs from TypeScript in tests and from compiled JavaScript in production. Applied migrations are never edited; changes go in a new one.

## Tables

| Table | Purpose | Key |
| --- | --- | --- |
| `transactions` | One row per sale and its payment status | `id` UUIDv7 |
| `transaction_lines` | Sale lines | `(transaction_id, line_no)` |
| `idempotency_keys` | Claims and stored responses for `Idempotency-Key` (#10) | `(merchant_id, idempotency_key)` |
| `outbox` | Events written in the same transaction as the state change (#12) | `id` bigint identity; `event_id` UUID unique |

## Invariants enforced by the database

The application validates everything first, but rules that protect money and PCI scope are also constraints, so a bug or a manual `UPDATE` can't break them.

| Constraint | Rule |
| --- | --- |
| `transactions_sale_once` | `UNIQUE (merchant_id, terminal_id, external_ref)`: a receipt is charged once even if the till loses its idempotency key. `merchant_id` is part of it because terminal ids are only unique per merchant. A violation becomes `409` with the existing transaction id. |
| `transactions_payment_token_check` | `payment_token ~ '^tok_[A-Za-z0-9]{8,64}$'`: a card number can't be stored, even by mistake. |
| `transactions_tax_within_total`, `*_minor_check` | Money is `bigint` minor units, positive total, tax ≤ total. |
| `transactions_status_check` | `TEXT` + `CHECK` rather than a PostgreSQL enum: adding a value later is a plain migration. |
| `transactions_failure_reason_only_when_failed` | A reason exists exactly when the status is `FAILED`. |
| `idempotency_keys_state_consistent` | `IN_PROGRESS` has a lock expiry and no response; `COMPLETED` has a stored response. |
| Primary key of `idempotency_keys` | The arbiter for concurrent requests: `INSERT … ON CONFLICT DO NOTHING` lets exactly one claim win (tested with 5 concurrent inserts). |

Column types: money is `bigint` (exact, and fast integer maths). Quantities are `numeric(13,3)` (exact decimals). All timestamps are `timestamptz`. node-postgres returns `bigint` and `numeric` as **strings** because they can exceed JavaScript's safe integer range; the repository layer converts them explicitly.

## Why each index exists

Measured on a seeded database: 200k transactions, 400k lines, 1M outbox rows (50 unpublished), 100k idempotency keys.

| Query | Index | Plan | Time |
| --- | --- | --- | --- |
| `GET /v1/transactions/{id}` | `transactions_pkey` | Index Scan | 0.05 ms |
| Lines of a transaction, in order | `transaction_lines_pkey` (prefix `transaction_id`, already sorted by `line_no`) | Index Scan, no Sort | 0.05 ms |
| Duplicate-sale check | `transactions_sale_once` (the unique constraint's index) | Index Scan | 0.04 ms |
| Idempotency claim / lookup | `idempotency_keys_pkey` | Index Scan | 0.03 ms |
| Outbox relay batch | `outbox_unpublished_idx` (partial) | Index Scan | 0.08 ms |
| Idempotency retention delete | `idempotency_keys_expires_at_idx` | Index Scan | n/a |

No extra index is needed for the API lookups: primary keys and unique constraints already create them. Every additional index slows every write, so each one has to pay for itself.

### The partial outbox index

```sql
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
```

The relay asks for "the oldest unpublished rows", and almost every row in the outbox is already published:

```
SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;

-- with the partial index
 Limit (actual rows=50 loops=1)
   ->  LockRows (actual rows=50 loops=1)
         ->  Index Scan using outbox_unpublished_idx on outbox (actual rows=50 loops=1)
 Execution Time: 0.078 ms

-- without it
 Limit (actual rows=50 loops=1)
   ->  LockRows (actual rows=50 loops=1)
         ->  Sort (actual rows=50 loops=1)
               ->  Seq Scan on outbox (actual rows=50 loops=1)
                     Filter: (published_at IS NULL)
                     Rows Removed by Filter: 999950
 Execution Time: 85.262 ms
```

| Index | Size |
| --- | --- |
| `outbox_unpublished_idx` (partial, only unpublished rows) | **16 kB** |
| Full index on `(published_at, id)` | 30 MB |

The partial index is as big as the backlog, not the table, and it already returns rows in `id` order, so there's no sort. The relay polls every few hundred milliseconds, so this is the difference between ~0.1 ms and ~85 ms per poll, growing with the table. Published rows still need a cleanup job eventually (#13), for table size and vacuum, not for this query.

## Why UUIDv7 primary keys

Ids are generated by the gateway (`src/database/uuidv7.ts`): 48 bits of milliseconds, a 12-bit counter, then random bits. New keys are larger than all existing ones, so inserts go to the right-most B-tree page instead of random pages. Knowing the id before the `INSERT` also lets the outbox event reference it in the same transaction.

Measured: 1M ids generated in Node, `COPY`'d into a table with a uuid primary key:

| Keys | Insert time | Primary key index | Leaf page fill |
| --- | --- | --- | --- |
| UUIDv4 (random) | 2.8 s | 38 MB | 71% |
| UUIDv7 (ours) | **1.2 s** | **30 MB** | **90%** |

Two lessons from getting there:

- **Millisecond ordering isn't enough.** The first version ordered ids only to the millisecond and used random bits after that. At ~220 inserts per millisecond, neighbouring inserts were still random within the newest pages; PostgreSQL then split pages 50/50 and the index came out the same size as v4. The 12-bit counter (RFC 9562 §6.2, method 1) makes ids strictly increasing within a process, which enables PostgreSQL's right-most page split (fills pages to 90%). PostgreSQL 18's built-in `uuidv7()` uses those bits as sub-millisecond precision for the same reason.
- **With everything in memory, v4's cost is CPU and page splits.** Once the index outgrows `shared_buffers`, random inserts also mean random disk reads, and the gap widens.

Trade-offs: a v7 id reveals its creation time (acceptable here: transactions carry `occurredAt` anyway), and ordering is per process (several gateway instances interleave within a millisecond, which is still far closer to sequential than v4).
