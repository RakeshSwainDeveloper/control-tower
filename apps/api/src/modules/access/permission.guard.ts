import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { PermissionKey } from '@ct/contracts';
import { PermissionService } from './permission.service.js';
import { REQUIRED_PERMISSIONS, NO_PERMISSION_REQUIRED } from './permission.decorator.js';
import { IS_PUBLIC } from '../auth/public.decorator.js';
import { enrichContext } from '../../common/correlation.js';

/**
 * Route-level authorisation.
 *
 * This is only the FIRST of two gates. It answers "does this user hold the key
 * anywhere at all", which is enough to decide whether the feature exists for
 * them (403). It deliberately does NOT decide which records they may see —
 * that is the data layer's job, applied as a query predicate, and answers 404
 * rather than 403 so existence is never disclosed (FR-566).
 *
 * Conflating the two is how products end up with endpoints that confirm a
 * record exists before refusing it.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = <T>(key: string): T | undefined =>
      this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);

    if (meta<boolean>(IS_PUBLIC)) return true;
    if (meta<boolean>(NO_PERMISSION_REQUIRED)) return true;

    const required = meta<PermissionKey[]>(REQUIRED_PERMISSIONS);

    // Fail closed. An authenticated route that declares nothing is a bug, and
    // it should surface as a broken endpoint in development, never as an
    // unguarded one in production.
    if (!required || required.length === 0) {
      throw new ForbiddenException(
        'This endpoint declares no permission requirement. ' +
          'Add @RequirePermission(...) or @NoPermissionRequired().',
      );
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (!req.auth) throw new ForbiddenException('Not authenticated');

    // ANY of the declared keys is sufficient: a route reachable by two
    // different roles states both rather than being duplicated.
    const satisfiedBy = required.find((k) => this.permissions.holds(req.auth!.permissions, k));
    if (!satisfiedBy) {
      throw new ForbiddenException(
        `Requires one of: ${required.join(', ')}`,
      );
    }

    /**
     * Record WHICH grant let this request through.
     *
     * FR-030 is that the audit trail says "Ramesh approved this as Project
     * Manager", not merely that Ramesh approved it. The grant and its label
     * were resolved right here, on every request, and then discarded — so
     * audit.write found nothing in the ambient context and 0 of 40 audit rows
     * carried a grant.
     *
     * The ambient context is the only place that covers every route. The
     * alternative was 104 withTenant call sites each remembering to pass it,
     * and 89 of them did not.
     */
    const scope = req.auth.permissions.keys[satisfiedBy];
    if (scope) {
      enrichContext({
        grantId: scope.grantId,
        responsibilityLabel: scope.responsibilityLabel,
      });
    }

    return true;
  }
}
