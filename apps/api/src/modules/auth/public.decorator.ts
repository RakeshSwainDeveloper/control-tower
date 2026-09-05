import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './auth.guard.js';

export const IS_PUBLIC = 'ct:isPublic';

/** Opt a route OUT of authentication. Applied sparingly and visibly: the guard
 *  is global, so forgetting this decorator fails closed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!req.auth) throw new Error('CurrentUser used on a route with no AuthGuard');
    return req.auth;
  },
);
