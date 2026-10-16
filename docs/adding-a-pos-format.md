# Adding a POS format

A till format is one adapter class in `src/ingestion/adapters/`. It turns raw request bytes into a canonical `NewSale` (see `src/canonical/`) or a list of field errors. Nothing in payments, the outbox or the canonical model changes when you add one.

## How a request finds its adapter

1. The `Content-Type` header is **authoritative**. Parameters and case are ignored (`Application/JSON; charset=utf-8` → `application/json`).
   - A registered media type goes to its adapter, **even if the body looks like another format**. A mismatched body then fails in that adapter with a `400`.
   - An unregistered specific type gets `415 Unsupported Media Type` with the list of supported types.
2. Only when the header is missing or `application/octet-stream` does the registry sniff the body with each adapter's `looksLike`.
   - Exactly one match → that adapter.
   - Zero or several matches → `400 unrecognised_format`. The registry never guesses between two formats.

Duplicate formats or media types are rejected when the app starts, not at request time.

## Steps

1. **Write the spec first.** Add `docs/formats/<format>.md`: media type(s), field mapping to the canonical model, units and implied decimals, character encoding, and how timestamps are converted to UTC.
2. **Add fixtures** under `fixtures/<format>/`: at least one valid sale per domain (EV charging in kWh, parking in minutes, shop items) and a few broken ones.
3. **Implement the adapter** in `src/ingestion/adapters/<format>.adapter.ts`:

   ```ts
   @Injectable()
   export class CsvTillAdapter implements PosFormatAdapter {
     readonly format = 'csv';                 // lowercase slug, stored as source.format
     readonly mediaTypes = ['text/csv'];      // lowercase, no parameters

     looksLike(raw: Buffer): boolean {        // cheap prefix check, never a full parse
       return raw.subarray(0, 8).toString('latin1').startsWith('SALE,');
     }

     parse(raw: Buffer): Result<NewSale> {
       // 1. decode + structural parsing; report errors with format-specific paths
       // 2. map to the canonical shape (UTC timestamps, minor units, source.format)
       // 3. return validateNewSale(mapped) so the canonical rules are always applied
     }
   }
   ```

   Rules:
   - **Never throw on bad input.** Return `fail([...])`. Exceptions are for bugs, not for bad till data.
   - **Error paths point at the source**, e.g. `L#3 cols 14-23` for fixed-width or `/Sale/Lines/Line[2]/Qty` for XML, so a till integrator can find the problem.
   - **Always finish with `validateNewSale`.** The adapter maps; the canonical schema decides what's valid.
   - **Normalise, don't reject, where the meaning is clear**: convert local time with an offset to UTC, or decimal strings to minor units. Reject anything ambiguous (a timestamp with no zone).
   - **Never log the raw body** (it could contain card data; see the PCI notes in the README).
4. **Register it** by adding the class to `ADAPTERS` in `src/ingestion/ingestion.module.ts`. That's the only line outside the adapter's own files.
5. **Tests checklist** (`<format>.adapter.spec.ts`):
   - [ ] every valid fixture parses to the expected `NewSale`
   - [ ] malformed input (truncated, wrong encoding, empty body) returns errors without throwing
   - [ ] missing required fields and bad numbers report the right source path
   - [ ] money in minor units, quantities with decimals, UTC conversion
   - [ ] `looksLike` is true for every valid fixture and false for the other formats' fixtures (no ambiguous sniffing)
   - [ ] a card-number-like value is rejected (see #11)

`test/ingestion-extension.spec.ts` shows a dummy adapter (`test/support/pipe-json.adapter.ts`) registered entirely from outside `src/`.
