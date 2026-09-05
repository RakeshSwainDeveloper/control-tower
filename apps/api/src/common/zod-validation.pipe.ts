import { PipeTransform, Injectable, type ArgumentMetadata } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Zod validation, applied per-handler with @UsePipes(new ZodValidationPipe(schema)).
 *
 * We use Zod rather than class-validator because the SAME schema is imported by
 * the web client from @ct/contracts — one definition drives API validation and
 * form types. A ZodError is turned into RFC 7807 by ProblemDetailFilter.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return this.schema.parse(value);
  }
}
