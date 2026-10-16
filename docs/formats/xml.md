# Legacy XML till format (schema version 1)

| | |
| --- | --- |
| Media types | `application/xml`, `text/xml` |
| Encoding | UTF-8 (default) or ISO-8859-1, as declared in `<?xml … encoding="…"?>` |
| Adapter | `src/ingestion/adapters/xml-till.adapter.ts` (`source.format = "xml"`), parser: `fast-xml-parser` |
| Fixtures | `fixtures/xml/` (EV charging with a UTC offset, Latin-1 parking, shop with entities) |

## Element mapping

| XML | Canonical field | Conversion |
| --- | --- | --- |
| `/Sale/@schemaVersion` | `source.schemaVersion` | must be `1` |
| `/Sale/Merchant` | `merchantId` | |
| `/Sale/Site` | `siteId` | |
| `/Sale/Terminal` | `terminalId` | |
| `/Sale/Receipt` | `externalRef` | |
| `/Sale/OccurredAt` | `occurredAt` | ISO 8601 with `Z` **or an offset**; offsets are converted to UTC |
| `/Sale/Currency` | `currency` | ISO 4217 |
| `/Sale/Totals/Total` | `totalMinor` | decimal → minor units (`11.32` → `1132`) |
| `/Sale/Totals/Tax` | `taxMinor` | decimal → minor units |
| `/Sale/Lines/Line[n]/Sku` | `lines[n-1].sku` | |
| `/Sale/Lines/Line[n]/Description` | `lines[n-1].description` | |
| `/Sale/Lines/Line[n]/Quantity` | `lines[n-1].quantity` | decimal, at most 3 places |
| `/Sale/Lines/Line[n]/Quantity/@unit` | `lines[n-1].unit` | `ITEM`, `KWH`, `MINUTE`, `LITRE` |
| `/Sale/Lines/Line[n]/UnitPrice` | `lines[n-1].unitPriceMinor` | decimal → minor units |
| `/Sale/Lines/Line[n]/LineTotal` | `lines[n-1].lineTotalMinor` | decimal → minor units |
| `/Sale/Lines/Line[n]/TaxRate` | `lines[n-1].taxRateBps` | percentage → basis points (`23.00` → `2300`) |
| `/Sale/Payment/@method` | `payment.method` | `CARD`, `WALLET`, `FLEET_CARD` |
| `/Sale/Payment/Token` | `payment.paymentToken` | `tok_…` |
| `/Sale/Payment/CardBrand` | `payment.cardBrand` | optional |

Unknown elements or attributes are rejected (strict, as in the JSON format). Namespaces and `metadata` aren't supported in version 1.

## Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Sale schemaVersion="1">
  <Merchant>MERCH01</Merchant>
  <Site>SITE042</Site>
  <Terminal>TERM0001</Terminal>
  <Receipt>R000123</Receipt>
  <OccurredAt>2026-10-15T15:30:00+01:00</OccurredAt>
  <Currency>EUR</Currency>
  <Totals><Total>11.32</Total><Tax>2.12</Tax></Totals>
  <Lines>
    <Line>
      <Sku>EV-KWH</Sku>
      <Description>DC fast charge</Description>
      <Quantity unit="KWH">18.500</Quantity>
      <UnitPrice>0.45</UnitPrice>
      <LineTotal>8.32</LineTotal>
      <TaxRate>23.00</TaxRate>
    </Line>
  </Lines>
  <Payment method="CARD"><Token>tok_8f3kD92LmQ</Token><CardBrand>VISA</CardBrand></Payment>
</Sale>
```

## Amounts

Legacy XML carries **decimal amounts**, so the adapter converts them with **string arithmetic**, never floats: `Number("8.3") * 100` is `830.0000000000001`. The number of decimal places comes from the currency (ISO 4217 minor units via `Intl`: EUR 2, JPY 0, KWD 3). More decimals than the currency allows is an **error**, never silent rounding. Only plain decimals are accepted: no signs, thousands separators, decimal commas or exponents.

## Timestamps

A timestamp with an offset has one unambiguous meaning, so it's **normalised** to UTC (`15:30:00+01:00` → `14:30:00Z`). A timestamp with no zone is **rejected**, because local time is ambiguous (DST). The date and time are validated as written before conversion, because JavaScript's `Date` silently rolls invalid values over (30 February becomes 2 March).

## Security

| Threat | Defence | Test |
| --- | --- | --- |
| XXE: `<!ENTITY x SYSTEM "file:///etc/passwd">` reads local files or calls internal URLs (SSRF) | any `<!DOCTYPE` or `<!ENTITY` is rejected **before parsing** | `security` tests |
| Billion laughs: nested entities expand to gigabytes | same: no DTD, no entity declarations | `security` tests |
| Internal entities (`fast-xml-parser` expands them by default) | same | `security` tests |
| Prototype pollution via `<__proto__>` | the library throws; the adapter catches it and returns a 400 | `security` tests |
| Mismatched tags (`fast-xml-parser`'s `parse()` accepts `<A>1</B>`) | `XMLValidator.validate` runs first | `well-formedness` tests |
| Card data echoed in errors | well-formedness errors report only the code, line and column, never the library's message (which can quote tag names) | `never quotes input` test |
| Numbers coerced by the parser (`000123` → `123`) | `parseTagValue: false`: every value stays a string | fixtures |

Payload size is limited by the HTTP layer (#9).

## Errors

Paths are XPath-like (1-based indexes) and point at what the till wrote, including errors raised by the canonical checks:

```json
{ "path": "/Sale/Lines/Line[1]/LineTotal", "message": "must be a decimal amount with at most 2 decimal places" }
{ "path": "/Sale/Totals/Total", "message": "must equal the sum of lineTotalMinor (1132)" }
{ "path": "line 4, col 20", "message": "malformed XML (InvalidTag)" }
```
