# JSON till format (schema version 1)

| | |
| --- | --- |
| Media type | `application/json` |
| Encoding | UTF-8 (a leading BOM is tolerated) |
| Adapter | `src/ingestion/adapters/json-till.adapter.ts` (`source.format = "json"`) |
| Machine-readable schema | [`json-sale-v1.schema.json`](json-sale-v1.schema.json) (JSON Schema 2020-12, generated from the zod schema; `npm run docs:schemas`) |
| Fixtures | `fixtures/json/` (EV charging, parking, shop with fuel) |

## Rules

- **Strict.** Unknown fields are rejected and named (`totalMnior: unknown field`), so typos fail loudly instead of looking like a missing field. Free-form till context goes in `metadata` (string values; at most 20 keys; keys up to 40 characters, values up to 500).
- **Versioned.** `schemaVersion` is required and must be a supported version (currently `"1"`, a string). A new optional field means a new schema version; the gateway supports old versions explicitly instead of guessing.
- **Money in minor units.** All `*Minor` fields are non-negative integers (cents). `8.32` and `"832"` are rejected.
- **UTC timestamps.** `occurredAt` is ISO 8601 ending in `Z`; fractional seconds are allowed.
- **Gross prices; the till owns tax and rounding.** `unitPriceMinor` and `lineTotalMinor` include tax. `totalMinor` must equal the sum of `lineTotalMinor`, `taxMinor` can't exceed it, and each line total must be within 1 cent of `quantity × unitPriceMinor`.
- **Tokens only.** `payment.paymentToken` is a provider token (`tok_` + 8–64 alphanumerics). There is no field for card data, and `payment.pan` (or anything else unknown) is rejected.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | string | `"1"` |
| `merchantId`, `siteId`, `terminalId`, `externalRef` | string, 1–64 | `terminalId` + `externalRef` identify the sale on the till |
| `occurredAt` | string | UTC, e.g. `2026-10-15T14:30:00Z` |
| `currency` | string | ISO 4217, uppercase |
| `totalMinor` | integer > 0 | gross amount to charge |
| `taxMinor` | integer ≥ 0 | tax contained in `totalMinor` |
| `lines[]` | 1–500 items | see below |
| `lines[].sku` | string, 1–32 | |
| `lines[].description` | string, 1–200 | |
| `lines[].quantity` | number > 0 | up to 3 decimals (kWh, litres) |
| `lines[].unit` | enum | `ITEM`, `KWH`, `MINUTE`, `LITRE` |
| `lines[].unitPriceMinor` | integer ≥ 0 | gross unit price |
| `lines[].lineTotalMinor` | integer ≥ 0 | gross line amount as printed |
| `lines[].taxRateBps` | integer 0–10000 | 2300 = 23% |
| `payment.method` | enum | `CARD`, `WALLET`, `FLEET_CARD` |
| `payment.paymentToken` | string | `tok_…` |
| `payment.cardBrand` | string, optional | uppercase, e.g. `VISA` |
| `metadata` | object, optional | string → string |

## Example

```json
{
  "schemaVersion": "1",
  "merchantId": "MERCH01",
  "siteId": "SITE042",
  "terminalId": "TERM0001",
  "externalRef": "R000123",
  "occurredAt": "2026-10-15T14:30:00Z",
  "currency": "EUR",
  "totalMinor": 1132,
  "taxMinor": 212,
  "lines": [
    { "sku": "EV-KWH", "description": "DC fast charge", "quantity": 18.5, "unit": "KWH",
      "unitPriceMinor": 45, "lineTotalMinor": 832, "taxRateBps": 2300 },
    { "sku": "PARKING-MIN", "description": "Parking while charging", "quantity": 60, "unit": "MINUTE",
      "unitPriceMinor": 5, "lineTotalMinor": 300, "taxRateBps": 2300 }
  ],
  "payment": { "method": "CARD", "paymentToken": "tok_8f3kD92LmQ", "cardBrand": "VISA" },
  "metadata": { "connectorId": "CCS2-2", "sessionId": "chg-77812" }
}
```

## Errors

A `400` lists every problem at once, each with a path into the body:

```json
{
  "error": "invalid_payload",
  "format": "json",
  "errors": [
    { "path": "totalMnior", "message": "unknown field" },
    { "path": "lines[1].unitPriceMinor", "message": "Invalid input: expected number, received undefined" }
  ]
}
```

Malformed JSON reports only the position (`malformed JSON at position 20`). The parser's own message is discarded because it quotes part of the body, which could contain card data.

## Known limitations

- Duplicate keys (`{"totalMinor": 1, "totalMinor": 1000}`) aren't detected: `JSON.parse` keeps the last one. Rejecting them needs a streaming parser.
- Request size limits are set by the HTTP layer (#9), not the adapter.
