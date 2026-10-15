import type { NewSale, Result } from '../canonical';

/**
 * One till format = one adapter. Adapters are pure: bytes in, canonical sale or field
 * errors out. They never throw on bad input and never touch the database or payments.
 */
export interface PosFormatAdapter {
  /** Slug stored as `source.format`, e.g. `json`, `fixed-width`, `xml`. */
  readonly format: string;
  /** Media types this adapter owns, lowercase, without parameters (e.g. `application/xml`). */
  readonly mediaTypes: readonly string[];
  /**
   * Cheap content check used only when the request has no specific Content-Type
   * (missing or `application/octet-stream`). Must not fully parse.
   */
  looksLike(raw: Buffer): boolean;
  parse(raw: Buffer): Result<NewSale>;
}

/** DI token for the list of registered adapters. */
export const POS_FORMAT_ADAPTERS = Symbol('POS_FORMAT_ADAPTERS');
