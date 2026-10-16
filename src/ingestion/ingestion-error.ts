import type { FieldError } from '../canonical';

export type IngestionError =
  /** A specific Content-Type that no adapter owns → 415. */
  | { kind: 'unsupported-media-type'; mediaType: string; supported: string[] }
  /** Generic or missing Content-Type and the body matches no (or several) adapters → 400. */
  | { kind: 'unrecognised-body'; candidates: string[] }
  /** The chosen adapter rejected the payload → 400 with field-level errors. */
  | { kind: 'invalid-payload'; format: string; errors: FieldError[] };
