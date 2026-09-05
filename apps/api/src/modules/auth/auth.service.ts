import {
  Injectable, Inject, UnauthorizedException, ForbiddenException,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { DB_TOKEN, ENV_TOKEN, LOGGER_TOKEN } from '../../common/tokens.js';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { CryptoService } from './crypto.service.js';
import { TokenService } from './token.service.js';

export interface LoginContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  deviceId?: string | undefined;
}

/** Exactly what app.resolve_login_by_* returns — no more. */
interface LoginIdentity {
  user_id: string;
  org_id: string;
  password_hash: string | null;
  status: string;
  permission_version: number;
  failed_logins: number;
  locked_until: Date | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(LOGGER_TOKEN) private readonly log: Logger,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  // ── Password login (office users) ───────────────────────────────
  async loginWithPassword(email: string, password: string, ctx: LoginContext): Promise<TokenPair> {
    // Login precedes tenant context, so a plain SELECT on app.users is blocked
    // by FORCE RLS — correctly. app.resolve_login_by_email is the narrow
    // SECURITY DEFINER bootstrap: exact match, one row, minimal columns.
    // See migration 0007 for why the policy was not weakened instead.
    const user = await this.resolveLogin('email', email);

    // Uniform failure. Distinguishing "no such user" from "wrong password"
    // turns the login form into an account-enumeration oracle.
    const generic = new UnauthorizedException('Invalid email or password');

    if (!user?.password_hash) {
      // Spend comparable time so absence is not detectable by timing.
      await this.crypto.verifyPassword(password, DUMMY_HASH);
      throw generic;
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new HttpException(
        `Account locked until ${user.locked_until.toISOString()} after repeated failed attempts`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await this.crypto.verifyPassword(password, user.password_hash);
    if (!ok) {
      await this.recordFailedLogin(user.user_id);
      throw generic;
    }
    if (user.status !== 'active') {
      throw new ForbiddenException(`Account is ${user.status}`);
    }

    return this.issueSession(user.org_id, user.user_id, user.permission_version, ctx, 'password');
  }

  // ── OTP request (site users) ────────────────────────────────────
  async requestOtp(phone: string, ctx: LoginContext): Promise<{ sent: boolean; dev_code?: string }> {
    const user = await this.resolveLogin('phone', phone);

    const code = this.crypto.generateOtp(this.env.OTP_LENGTH);

    // Always behave as if the number were valid: the response must not reveal
    // whether a phone is registered.
    if (user && user.status === 'active') {
      // The tenant is known from the resolver, so this runs scoped like any
      // other write. otp_challenges permits a NULL org_id for the case where
      // the number matches nobody — but here it does, so we scope it.
      await withTenant(this.db, { orgId: user.org_id }, (trx) =>
        trx.insertInto('app.otp_challenges').values({
          org_id: user.org_id,
          phone,
          code_hash: this.crypto.hashToken(code),
          expires_at: new Date(Date.now() + this.env.OTP_TTL_SECONDS * 1000),
          ip: ctx.ip ?? null,
        }).execute(),
      );
      this.log.info({ phone: maskPhone(phone) }, 'otp issued');
    } else {
      this.log.info({ phone: maskPhone(phone) }, 'otp requested for unknown or inactive number');
    }

    // Dev convenience only, gated on an explicit flag so it cannot leak by
    // default if NODE_ENV is ever mis-set in a deployed environment.
    return this.env.OTP_DEV_ECHO && this.env.NODE_ENV !== 'production'
      ? { sent: true, dev_code: code }
      : { sent: true };
  }

  // ── OTP verify ──────────────────────────────────────────────────
  async verifyOtp(phone: string, code: string, ctx: LoginContext): Promise<TokenPair> {
    const generic = new UnauthorizedException('Invalid or expired code');

    // Resolve the tenant from the phone first, then read the challenge under
    // tenant context like any other row.
    const identity = await this.resolveLogin('phone', phone);
    if (!identity) throw generic;

    const challenge = await withTenant(this.db, { orgId: identity.org_id }, (trx) =>
      trx.selectFrom('app.otp_challenges')
        .select(['id', 'org_id', 'code_hash', 'attempts', 'max_attempts', 'expires_at', 'consumed_at'])
        .where('phone', '=', phone)
        .where('consumed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
    );
    if (!challenge || challenge.expires_at < new Date()) throw generic;
    if (challenge.attempts >= challenge.max_attempts) {
      throw new HttpException(
        'Too many attempts. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.crypto.constantTimeEquals(this.crypto.hashToken(code), challenge.code_hash)) {
      await withTenant(this.db, { orgId: challenge.org_id! }, (trx) =>
        trx.updateTable('app.otp_challenges')
          .set({ attempts: challenge.attempts + 1 })
          .where('id', '=', challenge.id).execute(),
      );
      throw generic;
    }

    // The challenge row carries the tenant, so from here the normal scoped
    // path applies — no resolver needed.
    const user = await withTenant(this.db, { orgId: challenge.org_id! }, (trx) =>
      trx.selectFrom('app.users').select(['id', 'org_id', 'status', 'permission_version'])
        .where('phone', '=', phone).executeTakeFirst(),
    );
    if (!user || user.status !== 'active') throw generic;

    // Single use. Consumed before the session is issued, so a race cannot
    // redeem the same code twice.
    const consumed = await withTenant(this.db, { orgId: challenge.org_id! }, (trx) =>
      trx.updateTable('app.otp_challenges')
        .set({ consumed_at: new Date() })
        .where('id', '=', challenge.id)
        .where('consumed_at', 'is', null)
        .executeTakeFirst(),
    );
    if (Number(consumed.numUpdatedRows) !== 1) throw generic;

    return this.issueSession(user.org_id, user.id, user.permission_version, ctx, 'otp');
  }

  // ── Refresh with rotation and reuse detection ───────────────────
  async refresh(refreshToken: string, ctx: LoginContext): Promise<TokenPair> {
    const hash = this.crypto.hashToken(refreshToken);
    const generic = new UnauthorizedException('Invalid refresh token');

    // user_sessions is RLS-protected too, and the refresh token is the only
    // thing we hold. Resolve the tenant from the token hash, then switch to
    // the normal scoped path.
    const session = await this.resolveSession(hash);
    if (!session) throw generic;

    // A revoked session presented again means the token was captured. Rotation
    // alone does not help if the attacker refreshes first; killing the whole
    // family on reuse is what limits the damage.
    if (session.revoked_at) {
      this.log.warn({ sessionId: session.session_id, userId: session.user_id }, 'refresh token reuse detected');
      await this.revokeFamily(session.org_id, session.user_id, 'refresh token reuse detected');
      throw generic;
    }
    if (session.expires_at < new Date()) throw generic;

    const user = await withTenant(this.db, { orgId: session.org_id }, (trx) =>
      trx.selectFrom('app.users').select(['id', 'org_id', 'status', 'permission_version'])
        .where('id', '=', session.user_id).executeTakeFirst(),
    );
    if (!user || user.status !== 'active') throw generic;

    await withTenant(this.db, { orgId: session.org_id }, (trx) =>
      trx.updateTable('app.user_sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'rotated' })
        .where('id', '=', session.session_id).execute(),
    );

    return this.issueSession(
      user.org_id, user.id, user.permission_version, ctx, 'refresh', session.session_id,
    );
  }

  async logout(orgId: string, sessionId: string): Promise<void> {
    await withTenant(this.db, { orgId }, (trx) =>
      trx.updateTable('app.user_sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'logout' })
        .where('id', '=', sessionId).where('revoked_at', 'is', null).execute(),
    );
  }

  // ── internals ───────────────────────────────────────────────────
  private async issueSession(
    orgId: string, userId: string, permissionVersion: number,
    ctx: LoginContext, method: string, parentSessionId?: string,
  ): Promise<TokenPair> {
    const refreshToken = this.crypto.generateToken();

    const session = await withTenant(this.db, { orgId, userId }, async (trx) => {
      const s = await trx.insertInto('app.user_sessions').values({
        org_id: orgId,
        user_id: userId,
        refresh_token_hash: this.crypto.hashToken(refreshToken),
        parent_session_id: parentSessionId ?? null,
        device_id: ctx.deviceId ?? null,
        user_agent: ctx.userAgent?.slice(0, 500) ?? null,
        ip: ctx.ip ?? null,
        expires_at: new Date(Date.now() + this.tokens.refreshTtlMs()),
      }).returning(['id']).executeTakeFirstOrThrow();

      await trx.updateTable('app.users')
        .set({ last_login_at: new Date(), failed_logins: 0, locked_until: null })
        .where('id', '=', userId).execute();

      if (method !== 'refresh') {
        await this.audit.write(trx, orgId, {
          entityType: 'user', entityId: userId, action: 'login',
          context: { method, session_id: s.id, ip: ctx.ip ?? null },
          actorUserId: userId,
        });
      }
      return s;
    });

    const access = await this.tokens.signAccess({
      sub: userId, org: orgId, pv: permissionVersion, sid: session.id,
    });

    return {
      access_token: access,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTtlSeconds(),
    };
  }

  /** Also pre-authentication, so it uses the narrow definer function. */
  private async recordFailedLogin(userId: string): Promise<void> {
    await withoutTenant(this.db, 'failed-login counter precedes authentication', (trx) =>
      sql`SELECT app.record_failed_login(${userId}::uuid, ${MAX_FAILED_LOGINS}, ${LOCKOUT_MINUTES})`
        .execute(trx),
    );
  }

  private async resolveLogin(
    by: 'email' | 'phone', value: string,
  ): Promise<LoginIdentity | null> {
    const fn = by === 'email' ? 'resolve_login_by_email' : 'resolve_login_by_phone';
    const r = await withoutTenant(this.db, 'authentication precedes tenant context', (trx) =>
      sql<LoginIdentity>`
        SELECT (app.${sql.raw(fn)}(${value})).*
      `.execute(trx),
    );
    const row = r.rows[0];
    return row?.user_id ? row : null;
  }

  private async resolveSession(tokenHash: string) {
    const r = await withoutTenant(this.db, 'refresh precedes tenant context', (trx) =>
      sql<{ session_id: string; org_id: string; user_id: string;
            expires_at: Date; revoked_at: Date | null }>`
        SELECT (app.resolve_session_by_token(${tokenHash})).*
      `.execute(trx),
    );
    const row = r.rows[0];
    return row?.session_id ? row : null;
  }

  private async revokeFamily(orgId: string, userId: string, reason: string): Promise<void> {
    await withTenant(this.db, { orgId }, (trx) =>
      trx.updateTable('app.user_sessions')
        .set({ revoked_at: new Date(), revoked_reason: reason, reused_at: new Date() })
        .where('user_id', '=', userId).where('revoked_at', 'is', null).execute(),
    );
    this.permissions.invalidate(orgId, userId);
  }
}

/** Fixed argon2id hash of a random string, for constant-time absent-user paths. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$5vQZ8p1nJ3wZ0h5kWQq3oF1XcT9m0kQe8yLpNvR7sTk';

function maskPhone(p: string): string {
  return p.length <= 4 ? '****' : `${'*'.repeat(p.length - 4)}${p.slice(-4)}`;
}
