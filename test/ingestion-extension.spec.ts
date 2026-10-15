import { Test } from '@nestjs/testing';
import { AdapterRegistry, IngestionModule, POS_FORMAT_ADAPTERS } from '../src/ingestion';
import { PipeJsonAdapter } from './support/pipe-json.adapter';
import { parkingSale } from './support/sales';

/**
 * Proves the extension point through Nest DI: a format defined entirely outside src/
 * is registered and used without changing ingestion, canonical or payments code.
 */
describe('Ingestion extension point', () => {
  it('routes a sale to an adapter registered from outside the module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IngestionModule] })
      .overrideProvider(POS_FORMAT_ADAPTERS)
      .useValue([new PipeJsonAdapter()])
      .compile();

    const registry = moduleRef.get(AdapterRegistry);
    const result = registry.parse(undefined, Buffer.from(`PIPE|${JSON.stringify(parkingSale())}`));

    expect(registry.supportedMediaTypes).toEqual(['text/x-pipe-sale']);
    expect(result.ok && result.value.source.format).toBe('pipe-json');
  });
});
