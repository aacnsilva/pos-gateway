import { Module, type Type } from '@nestjs/common';
import { AdapterRegistry } from './adapter-registry';
import { FixedWidthTillAdapter } from './adapters/fixed-width.adapter';
import { JsonTillAdapter } from './adapters/json-till.adapter';
import { XmlTillAdapter } from './adapters/xml-till.adapter';
import { POS_FORMAT_ADAPTERS, type PosFormatAdapter } from './pos-format-adapter';

/**
 * Registered till formats. Adding a format = add its adapter class here (see
 * docs/adding-a-pos-format.md). Nothing outside the ingestion module changes.
 */
export const ADAPTERS: Type<PosFormatAdapter>[] = [
  JsonTillAdapter,
  FixedWidthTillAdapter,
  XmlTillAdapter,
];

/** Till format detection, parsers (adapters) and mapping to the canonical model (M1). */
@Module({
  providers: [
    ...ADAPTERS,
    {
      provide: POS_FORMAT_ADAPTERS,
      useFactory: (...adapters: PosFormatAdapter[]) => adapters,
      inject: ADAPTERS,
    },
    {
      provide: AdapterRegistry,
      useFactory: (adapters: PosFormatAdapter[]) => new AdapterRegistry(adapters),
      inject: [POS_FORMAT_ADAPTERS],
    },
  ],
  exports: [AdapterRegistry],
})
export class IngestionModule {}
