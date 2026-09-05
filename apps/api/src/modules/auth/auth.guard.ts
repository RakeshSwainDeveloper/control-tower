import {
  Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { enrichContext } from '../../common/correlation.js';
import { TokenService } from './token.service.js';
import { PermissionService, type CompiledPermissions } from '../access/permission.service.js';
import { IS_PUBLIC } from './public.decorator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedUser {
  userId: string;
  orgId: string;
  sessionId: string;
  permissions: CompiledPermissions;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser;
  }
}

/**
 * Authenticates the request and attaches the compiled permission set.
 *
 * Two things this deliberately does that a naive guard would not:
 *
 *  1. It re-reads `permission_version` from the database and compares it with
 *     the claim in the token. A grant revoked one minute ago must take effect
 *     on the next request, not in fifteen minutes when the access token
 *     expires. Revocation that waits for token expiry is not revocation.
 *
 *  2. It checks the session is still live. Logging out must actually log out,
 *     even though the access token is still cryptographically valid.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const claims = await this.tokens.verifyAccess(header.slice(7));

    // A platform token carries org='platform', which is not a tenant. Reject it
    // here rather than letting a non-UUID reach the database and surface as a
    // 500: a wrong-surface token is an authentication failure, not a fault.
    if (!UUID_RE.test(claims.org)) {
      throw new UnauthorizedException('Platform credentials are not valid on the tenant surface');
    }

    const live = await withTenant(this.db, { orgId: claims.org }, async (trx) => {
      const session = await trx
        .selectFrom('app.user_sessions')
        .select(['id', 'revoked_at', 'expires_at'])
        .where('id', '=', claims.sid)
        .executeTakeFirst();

      const user = await trx
        .selectFrom('app.users')
        .select(['id', 'status', 'permission_version'])
        .where('id', '=', claims.sub)
        .executeTakeFirst();

      return { session, user };
    });

    if (!live.session || live.session.revoked_at || live.session.expires_at < new Date()) {
      throw new UnauthorizedException('Session is no longer valid');
    }
    if (!live.user || live.user.status !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }

    // Authoritative version comes from the database, never from the token.
    const permissions = await this.permissions.get(
      claims.org, claims.sub, live.user.permission_version,
    );

    req.auth = {
      userId: claims.sub,
      orgId: claims.org,
      sessionId: claims.sid,
      permissions,
    };

    enrichContext({
      orgId: claims.org,
      userId: claims.sub,
      deviceId: (req.headers['x-device-id'] as string | undefined) ?? undefined,
      appVersion: (req.headers['x-app-version'] as string | undefined) ?? undefined,
    });

    // Touch last_seen without blocking the response.
    void withTenant(this.db, { orgId: claims.org }, (trx) =>
      trx.updateTable('app.user_sessions')
        .set({ last_seen_at: new Date() })
        .where('id', '=', claims.sid).execute(),
    ).catch(() => undefined);

    return true;
  }
}
