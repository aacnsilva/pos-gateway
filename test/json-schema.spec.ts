import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonSaleV1 } from '../src/ingestion/adapters/json-till.schema';

/**
 * The published JSON Schema is generated from the zod wire schema, never hand-edited.
 * This test fails when they drift; `npm run docs:schemas` regenerates the file.
 */
const file = join(__dirname, '../docs/formats/json-sale-v1.schema.json');

describe('published JSON Schema for JSON tills', () => {
  it('matches the zod wire schema', () => {
    const generated = `${JSON.stringify(
      {
        ...z.toJSONSchema(jsonSaleV1),
        title: 'POS sale (JSON till), schema version 1',
      },
      null,
      2,
    )}\n`;

    if (process.env.UPDATE_SCHEMAS === '1') writeFileSync(file, generated);
    expect(readFileSync(file, 'utf8')).toBe(generated);
  });
});
