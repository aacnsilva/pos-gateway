import { fail, ok, type NewSale, type Result } from '../canonical';
import type { IngestionError } from './ingestion-error';
import type { PosFormatAdapter } from './pos-format-adapter';

/** Content-Types that say nothing about the payload, so the body is sniffed instead. */
const GENERIC_MEDIA_TYPES = new Set(['', 'application/octet-stream']);

/**
 * Picks the adapter for a request. The Content-Type header is authoritative: a specific
 * type is never second-guessed by looking at the body. Sniffing happens only when the
 * header is missing or generic, and only an unambiguous single match is accepted.
 */
export class AdapterRegistry {
  private readonly byMediaType = new Map<string, PosFormatAdapter>();

  constructor(private readonly adapters: readonly PosFormatAdapter[]) {
    const formats = new Set<string>();
    for (const adapter of adapters) {
      if (formats.has(adapter.format)) {
        throw new Error(`Duplicate POS format adapter: ${adapter.format}`);
      }
      formats.add(adapter.format);
      for (const mediaType of adapter.mediaTypes) {
        const owner = this.byMediaType.get(mediaType);
        if (owner) {
          throw new Error(
            `Media type ${mediaType} claimed by both ${owner.format} and ${adapter.format}`,
          );
        }
        this.byMediaType.set(mediaType, adapter);
      }
    }
  }

  get supportedMediaTypes(): string[] {
    return [...this.byMediaType.keys()].sort();
  }

  resolve(contentType: string | undefined, raw: Buffer): Result<PosFormatAdapter, IngestionError> {
    const mediaType = normaliseMediaType(contentType);

    if (!GENERIC_MEDIA_TYPES.has(mediaType)) {
      const adapter = this.byMediaType.get(mediaType);
      return adapter
        ? ok(adapter)
        : fail({ kind: 'unsupported-media-type', mediaType, supported: this.supportedMediaTypes });
    }

    const candidates = this.adapters.filter((adapter) => adapter.looksLike(raw));
    const [only] = candidates;
    return candidates.length === 1 && only
      ? ok(only)
      : fail({ kind: 'unrecognised-body', candidates: candidates.map((a) => a.format) });
  }

  parse(contentType: string | undefined, raw: Buffer): Result<NewSale, IngestionError> {
    const resolved = this.resolve(contentType, raw);
    if (!resolved.ok) return resolved;

    const adapter = resolved.value;
    const parsed = adapter.parse(raw);
    return parsed.ok
      ? parsed
      : fail({ kind: 'invalid-payload', format: adapter.format, errors: parsed.errors });
  }
}

/** `Application/JSON; charset=utf-8` → `application/json` */
export function normaliseMediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
}
