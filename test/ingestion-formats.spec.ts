import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AdapterRegistry, IngestionModule } from '../src/ingestion';

const fixturesDir = join(__dirname, '../fixtures');
const formats = [
  { dir: 'json', format: 'json', contentType: 'application/json' },
  { dir: 'fixed-width', format: 'fixed-width', contentType: 'text/plain; charset=ISO-8859-1' },
  { dir: 'xml', format: 'xml', contentType: 'application/xml' },
];
const cases = formats.flatMap(({ dir, ...rest }) =>
  readdirSync(join(fixturesDir, dir)).map((file) => ({ file: `${dir}/${file}`, ...rest })),
);

describe('Ingestion with all registered formats', () => {
  let registry: AdapterRegistry;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IngestionModule] }).compile();
    registry = moduleRef.get(AdapterRegistry);
  });

  it('registers every format', () => {
    expect(registry.supportedMediaTypes).toEqual([
      'application/json',
      'application/xml',
      'text/plain',
      'text/x-fixed-width',
      'text/xml',
    ]);
  });

  it.each(cases)('$file parses via its Content-Type', ({ file, format, contentType }) => {
    const result = registry.parse(contentType, readFileSync(join(fixturesDir, file)));
    expect(result.ok ? result.value.source.format : result.errors).toBe(format);
  });

  it.each(cases)('$file is sniffed unambiguously without a Content-Type', ({ file, format }) => {
    const resolved = registry.resolve(undefined, readFileSync(join(fixturesDir, file)));
    expect(resolved.ok ? resolved.value.format : resolved.errors).toBe(format);
  });
});
