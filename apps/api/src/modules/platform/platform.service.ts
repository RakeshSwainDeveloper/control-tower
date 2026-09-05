import {
  Injectable, Inject, UnauthorizedException, ForbiddenException,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { DB_TOKEN, LOGGER_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { CryptoService } from '../auth/crypto.service.js';
import { correlationId } from '../../common/correlation.js';

export interface PlatformActor {
  platformUserId: string;
  role: 'platform_owner' | 'platform_support';
}

const MAX_IMPERSONATION_MINUTES = 60;

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(LOGGER_TOKEN) private readonly log: Logger,
    private readonly provisioning: ProvisioningService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ── Platform authentication (separate identity domain) ───────────
  async login(email: string, password: string) {
    const user = await withoutTenant(this.db, 'platform users are not tenant data', (trx) =>
      trx.selectFrom('app.platform_users')
        .select(['id', 'email', 'name', 'password_hash', 'platform_role', 'is_active'])
        .where('email', '=', email.toLowerCase())
        .executeTakeFirst(),
    );
    const generic = new UnauthorizedException('Invalid credentials');
    if (!user || !user.is_active) throw generic;
    if (!(await this.crypto.verifyPassword(password, user.password_hash))) throw generic;

    await withoutTenant(this.db, 'platform audit', (trx) =>
      trx.insertInto('app.platform_audit_log').values({
        platform_user_id: user.id, platform_role: user.platform_role,
        action: 'platform.login', correlation_id: correlationId(),
      }).execute(),
    );
    return { id: user.id, email: user.email, name: user.name, role: user.platform_role };
  }

  // ── Organizations ────────────────────────────────────────────────
  /**
   * Aggregate-only tenant listing.
   *
   * FR-079a: platform staff see shapes and volumes, never record content.
   * This deliberately returns counts, not names of projects or users.
   */
  async listOrganizations(actor: PlatformActor) {
    const rows = await withoutTenant(this.db, 'platform aggregate view', async (trx) => {
      // Counting app.users directly returns 0: RLS is doing its job and this
      // runs without tenant context. app.platform_org_metrics() is a
      // counts-only function that satisfies FR-079a by construction.
      const r = await sql<{
        id: string; display_name: string; slug: string; status: string;
        created_at: Date; user_count: number; active_users: number; last_login: Date | null;
      }>`
        SELECT o.id, o.display_name, o.slug, o.status, o.created_at,
               COALESCE(m.user_count, 0)   AS user_count,
               COALESCE(m.active_users, 0) AS active_users,
               m.last_login
        FROM app.organizations o
        LEFT JOIN app.platform_org_metrics() m ON m.org_id = o.id
        ORDER BY o.created_at DESC
      `.execute(trx);
      return r.rows;
    });
    void actor;
    return rows.map((r) => ({
      ...r,
      user_count: Number(r.user_count),
      active_users: Number(r.active_users),
    }));
  }

  async createOrganization(
    actor: PlatformActor,
    input: { legalName: string; displayName: string; slug: string },
  ) {
    const result = await this.provisioning.provisionOrganization(input);
    await this.platformAudit(actor, 'organization.create', {
      targetType: 'organization', targetId: result.orgId, targetOrgId: result.orgId,
      changes: { slug: input.slug, display_name: input.displayName },
    });
    return result;
  }

  async setOrganizationStatus(
    actor: PlatformActor, orgId: string,
    status: 'trial' | 'active' | 'suspended' | 'read_only' | 'closed',
    reason: string,
  ) {
    if (actor.role !== 'platform_owner') {
      throw new ForbiddenException('Only a platform owner may change organization status');
    }
    const before = await withoutTenant(this.db, 'platform tenant management', (trx) =>
      trx.selectFrom('app.organizations').selectAll().where('id', '=', orgId).executeTakeFirst(),
    );
    if (!before) throw new NotFoundException('Organization not found');

    const after = await withoutTenant(this.db, 'platform tenant management', (trx) =>
      trx.updateTable('app.organizations')
        .set({ status, suspended_reason: status === 'suspended' ? reason : null })
        .where('id', '=', orgId).returningAll().executeTakeFirstOrThrow(),
    );

    await this.platformAudit(actor, 'organization.status_change', {
      targetType: 'organization', targetId: orgId, targetOrgId: orgId,
      reason, changes: { from: before.status, to: status },
    });

    // Dual-write: the customer must be able to see what we did inside their
    // account without asking us (FR-510).
    await withTenant(this.db, { orgId }, (trx) =>
      this.audit.write(trx, orgId, {
        entityType: 'organization', entityId: orgId, action: 'config_change',
        changes: [{ field: 'status', old: before.status, new: status }],
        context: { by: 'platform staff', platform_user_id: actor.platformUserId, reason },
        source: 'system', responsibilityLabel: 'Platform Support',
      }),
    );
    return after;
  }

  /** Metadata only. Never the users' records — see FR-079a. */
  async listOrgUsers(actor: PlatformActor, orgId: string) {
    void actor;
    return withTenant(this.db, { orgId }, (trx) =>
      trx.selectFrom('app.users')
        .select(['id', 'name', 'email', 'phone', 'status', 'mfa_enabled',
                 'last_login_at', 'failed_logins', 'locked_until'])
        .orderBy('created_at').execute(),
    );
  }

  // ── Impersonation ────────────────────────────────────────────────
  async startImpersonation(
    actor: PlatformActor,
    input: { orgId: string; userId: string; reason: string; minutes: number },
  ) {
    if (input.reason.trim().length < 10) {
      throw new BadRequestException('A specific reason of at least 10 characters is required');
    }
    if (input.minutes > MAX_IMPERSONATION_MINUTES) {
      throw new BadRequestException(`Impersonation is capped at ${MAX_IMPERSONATION_MINUTES} minutes`);
    }

    const target = await withTenant(this.db, { orgId: input.orgId }, (trx) =>
      trx.selectFrom('app.users').select(['id', 'name']).where('id', '=', input.userId).executeTakeFirst(),
    );
    if (!target) throw new NotFoundException('User not found');

    const session = await withoutTenant(this.db, 'platform impersonation record', (trx) =>
      trx.insertInto('app.impersonation_sessions').values({
        platform_user_id: actor.platformUserId,
        target_org_id: input.orgId,
        target_user_id: input.userId,
        reason: input.reason,
        allow_writes: false,     // MVP is read-only, full stop
        expires_at: new Date(Date.now() + input.minutes * 60_000),
      }).returningAll().executeTakeFirstOrThrow(),
    );

    await this.platformAudit(actor, 'impersonation.start', {
      targetType: 'user', targetId: input.userId, targetOrgId: input.orgId,
      reason: input.reason, changes: { expires_at: session.expires_at },
    });

    // Visible in the customer's own audit trail, immediately.
    await withTenant(this.db, { orgId: input.orgId }, (trx) =>
      this.audit.write(trx, input.orgId, {
        entityType: 'user', entityId: input.userId, action: 'impersonation',
        context: {
          platform_user_id: actor.platformUserId, reason: input.reason,
          read_only: true, expires_at: session.expires_at,
        },
        source: 'impersonation', responsibilityLabel: 'Platform Support',
      }),
    );

    this.log.warn(
      { platformUser: actor.platformUserId, org: input.orgId, target: input.userId },
      'impersonation session started',
    );

    return {
      id: session.id,
      expires_at: session.expires_at,
      read_only: true,
      banner: `Support session — read-only — ends ${session.expires_at.toISOString()}`,
    };
  }

  async endImpersonation(actor: PlatformActor, id: string) {
    const s = await withoutTenant(this.db, 'platform impersonation record', (trx) =>
      trx.updateTable('app.impersonation_sessions')
        .set({ ended_at: new Date(), ended_reason: 'ended by operator' })
        .where('id', '=', id).where('ended_at', 'is', null)
        .returningAll().executeTakeFirst(),
    );
    if (!s) throw new NotFoundException('No active impersonation session with that id');
    await this.platformAudit(actor, 'impersonation.end', {
      targetType: 'user', targetId: s.target_user_id, targetOrgId: s.target_org_id,
    });
    return { ended: true };
  }

  async listImpersonations(actor: PlatformActor) {
    void actor;
    return withoutTenant(this.db, 'platform audit view', (trx) =>
      trx.selectFrom('app.impersonation_sessions')
        .selectAll().orderBy('started_at', 'desc').limit(100).execute(),
    );
  }

  // ── Feature flags ────────────────────────────────────────────────
  async listFlags() {
    return withoutTenant(this.db, 'the flag catalogue is platform data', (trx) =>
      trx.selectFrom('app.feature_flag_defs')
        .select(['flag_key', 'description', 'default_enabled', 'is_active'])
        .orderBy('flag_key').execute(),
    );
  }

  async setOrgFlag(
    actor: PlatformActor,
    orgId: string, flagKey: string, enabled: boolean, reason: string,
  ) {
    // Tenant overrides are tenant data, so this runs under tenant context like
    // any other write — the Super Admin acts on ONE org at a time.
    const row = await withTenant(this.db, { orgId }, (trx) =>
      trx.insertInto('app.org_feature_flags')
        .values({ org_id: orgId, flag_key: flagKey, is_enabled: enabled, reason })
        .onConflict((oc) => oc.columns(['org_id', 'flag_key'])
          .doUpdateSet({ is_enabled: enabled, reason }))
        .returningAll().executeTakeFirstOrThrow(),
    );
    await this.platformAudit(actor, 'feature_flag.set', {
      targetType: 'org_feature_flag', targetId: row.id, targetOrgId: orgId,
      reason, changes: { flag: flagKey, enabled },
    });
    return row;
  }

  // ── Platform audit ───────────────────────────────────────────────
  async platformAuditLog(limit = 100) {
    return withoutTenant(this.db, 'platform audit view', (trx) =>
      trx.selectFrom('app.platform_audit_log')
        .selectAll().orderBy('occurred_at', 'desc').limit(limit).execute(),
    );
  }

  private async platformAudit(
    actor: PlatformActor, action: string,
    opts: {
      targetType?: string; targetId?: string; targetOrgId?: string;
      reason?: string; changes?: Record<string, unknown>;
    },
  ): Promise<void> {
    await withoutTenant(this.db, 'platform audit stream', (trx) =>
      trx.insertInto('app.platform_audit_log').values({
        platform_user_id: actor.platformUserId,
        platform_role: actor.role,
        action,
        target_type: opts.targetType ?? null,
        target_id: opts.targetId ?? null,
        target_org_id: opts.targetOrgId ?? null,
        reason: opts.reason ?? null,
        changes: JSON.stringify(opts.changes ?? {}),
        correlation_id: correlationId(),
      }).execute(),
    );
  }
}
