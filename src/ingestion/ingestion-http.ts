import { BadRequestException, HttpException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { IngestionError } from './ingestion-error';

/** Maps an ingestion failure to the HTTP error the till receives. */
export function toHttpException(error: IngestionError): HttpException {
  switch (error.kind) {
    case 'unsupported-media-type':
      return new UnsupportedMediaTypeException({
        error: 'unsupported_media_type',
        message: `Content-Type ${error.mediaType} is not supported`,
        supported: error.supported,
      });
    case 'unrecognised-body':
      return new BadRequestException({
        error: 'unrecognised_format',
        message:
          error.candidates.length > 1
            ? `Body matches several formats (${error.candidates.join(', ')}); send a specific Content-Type`
            : 'Body does not match any supported format; send a specific Content-Type',
      });
    case 'invalid-payload':
      return new BadRequestException({
        error: 'invalid_payload',
        format: error.format,
        errors: error.errors,
      });
  }
}
