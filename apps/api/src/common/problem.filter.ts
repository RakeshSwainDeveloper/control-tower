import {
  Catch, HttpException, HttpStatus,
  type ArgumentsHost, type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { SodViolationError } from '@ct/contracts';
import { MissingTenantContextError } from '@ct/db';
import type { Logger } from 'pino';
import { supportReference, correlationId } from './correlation.js';

/**
 * RFC 7807 problem+json for every error, always carrying a support reference
 * that maps to a server log entry (NFR-17).
 *
 * Deliberate: internal errors never leak their message to the client. The
 * client gets a reference; the detail lives in the log.
 */
@Catch()
export class ProblemDetailFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<FastifyReply>();
    const ref = supportReference();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let type = 'about:blank';
    let detail: string | undefined;
    let errors: { path: string; message: string }[] | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = 'Validation Failed';
      type = 'https://controltower.dev/problems/validation';
      errors = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof SodViolationError) {
      // Separation of duty is a 403, and the rule id is told to the user:
      // "you cannot approve your own record" must be comprehensible, not opaque.
      status = HttpStatus.FORBIDDEN;
      title = 'Separation of Duty';
      type = `https://controltower.dev/problems/sod/${exception.rule}`;
      detail = exception.message;
    } else if (isTriggerRule(exception)) {
      /**
       * A business rule enforced by a database trigger.
       *
       * Twelve rules in this schema are enforced with `RAISE EXCEPTION … USING
       * ERRCODE = 'check_violation'`, and every message is written for the
       * person who will read it: "This issue has 1 unanswered question(s).
       * Answer them before closing it."
       *
       * Until Phase 7 all twelve surfaced as a bare 500 with no detail. The
       * rule fired correctly and the user was told nothing — which is worse
       * than the rule not existing, because they cannot even work out what to
       * fix.
       *
       * The discriminator is `constraint`: a genuine column CHECK carries the
       * constraint name and a message written for a DBA, while a trigger's
       * RAISE carries none and a message written for a person. Only the second
       * is ever shown.
       */
      status = HttpStatus.CONFLICT;
      title = 'Cannot do that yet';
      type = 'https://controltower.dev/problems/business-rule';
      detail = (exception as { message: string }).message;
    } else if (exception instanceof MissingTenantContextError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      title = 'Internal Server Error';
      detail = undefined; // never leak
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = exception.name.replace(/Exception$/, '');
      if (typeof body === 'string') detail = body;
      else if (body && typeof body === 'object' && 'message' in body) {
        const m = (body as { message: unknown }).message;
        detail = Array.isArray(m) ? m.join('; ') : String(m);
      }
    }

    const problem = {
      type,
      title,
      status,
      ...(detail ? { detail } : {}),
      support_reference: ref,
      correlation_id: correlationId(),
      ...(errors ? { errors } : {}),
    };

    // NFR-17: every tenant-visible error carries a support reference that maps
    // to a log entry. A 5xx with no log makes that reference worthless, so the
    // logging is part of the filter rather than left to whoever threw.
    if (status >= 500) {
      this.log.error(
        { err: exception, support_reference: ref, correlation_id: correlationId(), status },
        'unhandled error',
      );
    } else if (status >= 400) {
      this.log.debug(
        { support_reference: ref, status, title, detail },
        'request refused',
      );
    }

    void res.status(status).type('application/problem+json').send(problem);
  }
}

/**
 * A Postgres error raised by one of our own triggers, rather than by a column
 * constraint. `code` 23514 is check_violation; a real CHECK sets `constraint`,
 * a `RAISE EXCEPTION` does not.
 */
function isTriggerRule(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; constraint?: unknown; message?: unknown };
  return err.code === '23514'
    && !err.constraint
    && typeof err.message === 'string'
    && err.message.length > 0;
}
