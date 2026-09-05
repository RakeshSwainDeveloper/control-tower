import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException, Inject,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { withoutTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { TokenService } from '../auth/token.service.js';
import type { PlatformActor } from './platform.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    platform?: PlatformActor;
  }
}

/**
 * Authenticates a PLATFORM user — a separate identity domain from tenant users
 * (SUPER_ADMIN.md §2).
 *
 * A tenant access token must never satisfy this guard and vice versa. The
 * separation is enforced by the `org` claim: a platform token carries none, so
 * a tenant token presented here is rejected structurally rather than by a
 * lookup that might one day be wrong.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing platform bearer token');
    }

    const claims = await this.tokens.verifyAccess(header.slice(7));

    // A tenant token carries an org. A platform token must not.
    if (claims.org && claims.org !== 'platform') {
      throw new UnauthorizedException('Tenant credentials are not valid on the platform surface');
    }

    const user = await withoutTenant(this.db, 'platform users are not tenant data', (trx) =>
      trx.selectFrom('app.platform_users')
        .select(['id', 'platform_role', 'is_active'])
        .where('id', '=', claims.sub).executeTakeFirst(),
    );
    if (!user?.is_active) throw new UnauthorizedException('Platform account is not active');

    req.platform = {
      platformUserId: user.id,
      role: user.platform_role as PlatformActor['role'],
    };
    return true;
  }
}
