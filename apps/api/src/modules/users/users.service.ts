import {
  Injectable, Inject, ConflictException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { SEED_ROLES } from '@ct/contracts';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { CryptoService } from '../auth/crypto.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { Page } from '@ct/contracts';

export interface Actor { userId: string; orgId: string; responsibility?: string }

const INVITE_TTL_DAYS = 14;

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly crypto: CryptoService,
  ) {}

  // ── Users ────────────────────────────────────────────────────────
  async list(
    actor: Actor,
    opts: { cursor?: string; limit: number; status?: string; q?: string },
  ): Promise<Page<Record<string, unknown>>> {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx
        .selectFrom('app.users')
        .select(['id', 'name', 'email', 'phone', 'user_type', 'status',
                 'locale', 'mfa_enabled', 'last_login_at', 'created_at'])
        .orderBy('id', 'desc')
        .limit(opts.limit + 1);   // +1 tells us whether another page exists

      if (opts.status) qb = qb.where('status', '=', opts.status as 'active');
      if (opts.q) {
        const like = `%${opts.q.toLowerCase()}%`;
        qb = qb.where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['name']), 'like', like),
            eb(eb.fn('lower', ['email']), 'like', like),
            eb('phone', 'like', like),
          ]),
        );
      }
      // Keyset, not offset: a user list is small today but the same helper
      // shape is reused for ledgers, where OFFSET degrades badly (FR-516).
      if (opts.cursor) qb = qb.where('id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data: data as unknown as Record<string, unknown>[],
        next_cursor: hasMore ? (data[data.length - 1]!.id as string) : null,
        has_more: hasMore,
      };
    });
  }

  async create(actor: Actor, input: { name: string; email?: string; phone?: string; locale: string }) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const clash = await trx
        .selectFrom('app.users')
        .select('id')
        .where((eb) =>
          eb.or([
            ...(input.email ? [eb(eb.fn('lower', ['email']), '=', input.email.toLowerCase())] : []),
            ...(input.phone ? [eb('phone', '=', input.phone)] : []),
          ]),
        )
        .executeTakeFirst();
      if (clash) throw new ConflictException('A user with that email or phone already exists');

      const user = await trx
        .insertInto('app.users')
        .values({
          org_id: actor.orgId,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          user_type: 'internal',
          locale: input.locale,
          status: 'invited',
          created_by: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'user', entityId: user.id, action: 'create',
        changes: this.audit.diff(null, {
          name: user.name, email: user.email, phone: user.phone, status: user.status,
        }),
      });
      return user;
    });
  }

  async deactivate(actor: Actor, userId: string, reason: string) {
    if (userId === actor.userId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.users').selectAll().where('id', '=', userId).executeTakeFirst(),
        'User',
      );

      const after = await trx
        .updateTable('app.users')
        .set({ status: 'deactivated', updated_by: actor.userId })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Terminate every live session immediately. Deactivation that waits for
      // an access token to expire is not deactivation.
      await trx.updateTable('app.user_sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'user deactivated' })
        .where('user_id', '=', userId).where('revoked_at', 'is', null).execute();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'user', entityId: userId, action: 'update',
        changes: this.audit.diff(before, after),
        context: { reason },
      });
      this.permissions.invalidate(actor.orgId, userId);
      return after;
    });
  }

  // ── Roles ────────────────────────────────────────────────────────
  async listRoles(actor: Actor) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const roles = await trx
        .selectFrom('app.roles')
        .select((eb) => [
          'id', 'code', 'name', 'description', 'is_system', 'is_external', 'is_active',
          sql<string[]>`${eb.ref('applicable_scope_levels')}::text[]`.as('applicable_scope_levels'),
        ])
        .orderBy('name')
        .execute();

      const perms = await trx
        .selectFrom('app.role_permissions')
        .select(['role_id', 'permission_key', 'record_qualifier'])
        .execute();

      const byRole = new Map<string, Array<{ key: string; qualifier: string }>>();
      for (const p of perms) {
        const list = byRole.get(p.role_id) ?? [];
        list.push({ key: p.permission_key, qualifier: p.record_qualifier });
        byRole.set(p.role_id, list);
      }
      return roles.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] }));
    });
  }

  async createRole(
    actor: Actor,
    input: { code: string; name: string; description?: string;
             scopeLevels: string[]; permissions: Array<{ key: string; qualifier: string }> },
  ) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const clash = await trx.selectFrom('app.roles').select('id')
        .where('code', '=', input.code).executeTakeFirst();
      if (clash) throw new ConflictException(`Role code '${input.code}' already exists`);

      const role = await trx.insertInto('app.roles').values({
        org_id: actor.orgId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_system: false,          // tenant-created roles are never system roles
        applicable_scope_levels: input.scopeLevels as ('org' | 'project')[],
        created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();

      await trx.insertInto('app.role_permissions').values(
        input.permissions.map((p) => ({
          org_id: actor.orgId,
          role_id: role.id,
          permission_key: p.key,
          record_qualifier: p.qualifier as 'all_in_scope',
        })),
      ).execute();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'role', entityId: role.id, action: 'create',
        changes: this.audit.diff(null, { code: role.code, name: role.name }),
        context: { permission_count: input.permissions.length },
      });
      return { ...role, permissions: input.permissions };
    });
  }

  // ── Grants ───────────────────────────────────────────────────────
  async listGrants(actor: Actor, userId?: string) {
    return withTenant(this.db, { orgId: actor.orgId }, (trx) => {
      let qb = trx
        .selectFrom('app.role_grants as g')
        .innerJoin('app.roles as r', 'r.id', 'g.role_id')
        .innerJoin('app.users as u', 'u.id', 'g.user_id')
        .select(['g.id', 'g.user_id', 'u.name as user_name', 'g.role_id',
                 'r.code as role_code', 'r.name as role_name',
                 'g.scope_type', 'g.scope_id', 'g.responsibility_label',
                 'g.valid_from', 'g.valid_to', 'g.granted_by', 'g.created_at'])
        .where('g.revoked_at', 'is', null)
        .orderBy('g.created_at', 'desc');
      if (userId) qb = qb.where('g.user_id', '=', userId);
      return qb.execute();
    });
  }

  async grant(
    actor: Actor,
    input: { userId: string; roleId: string; scopeType: string;
             scopeId?: string; responsibilityLabel?: string; validTo?: Date },
  ) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const role = assertVisible(
        await trx.selectFrom('app.roles')
          .select((eb) => [
            'id', 'code', 'name', 'is_active',
            sql<string[]>`${eb.ref('applicable_scope_levels')}::text[]`.as('applicable_scope_levels'),
          ])
          .where('id', '=', input.roleId).executeTakeFirst(),
        'Role',
      );
      if (!role.is_active) throw new BadRequestException('That role is inactive');

      if (!role.applicable_scope_levels.includes(input.scopeType as 'org')) {
        throw new BadRequestException(
          `Role '${role.code}' cannot be granted at ${input.scopeType} scope ` +
            `(allowed: ${role.applicable_scope_levels.join(', ')})`,
        );
      }

      assertVisible(
        await trx.selectFrom('app.users').select(['id', 'status'])
          .where('id', '=', input.userId).executeTakeFirst(),
        'User',
      );

      const label =
        input.responsibilityLabel ??
        SEED_ROLES.find((r) => r.code === role.code)?.responsibility ??
        role.name;

      const existing = await trx.selectFrom('app.role_grants').select('id')
        .where('user_id', '=', input.userId)
        .where('role_id', '=', input.roleId)
        .where('scope_type', '=', input.scopeType as 'org')
        .where((eb) => input.scopeId ? eb('scope_id', '=', input.scopeId) : eb('scope_id', 'is', null))
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (existing) throw new ConflictException('That grant already exists');

      const g = await trx.insertInto('app.role_grants').values({
        org_id: actor.orgId,
        user_id: input.userId,
        role_id: input.roleId,
        scope_type: input.scopeType as 'org',
        scope_id: input.scopeId ?? null,
        responsibility_label: label,
        valid_to: input.validTo ?? null,
        granted_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();

      await this.bumpPermissionVersion(trx, actor.orgId, input.userId);

      await this.audit.write(trx, actor.orgId, {
        entityType: 'role_grant', entityId: g.id, action: 'create',
        changes: this.audit.diff(null, {
          user_id: g.user_id, role: role.code,
          scope_type: g.scope_type, scope_id: g.scope_id,
          responsibility_label: g.responsibility_label,
        }),
      });
      return g;
    });
  }

  async revokeGrant(actor: Actor, grantId: string, reason: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.role_grants').selectAll()
          .where('id', '=', grantId).where('revoked_at', 'is', null).executeTakeFirst(),
        'Grant',
      );

      const after = await trx.updateTable('app.role_grants')
        .set({ revoked_at: new Date(), revoked_by: actor.userId, revoke_reason: reason })
        .where('id', '=', grantId)
        .returningAll().executeTakeFirstOrThrow();

      await this.bumpPermissionVersion(trx, actor.orgId, before.user_id);

      await this.audit.write(trx, actor.orgId, {
        entityType: 'role_grant', entityId: grantId, action: 'delete',
        changes: this.audit.diff(before, after),
        context: { reason },
      });
      // Revoking a grant never alters records already created under it: the
      // responsibility label was copied onto those rows at write time (FR-028).
      return { revoked: true };
    });
  }

  /**
   * Bumps `users.permission_version` and drops the cached set.
   *
   * This is what makes revocation take effect on the NEXT request rather than
   * whenever the access token happens to expire. The auth guard re-reads this
   * value every request and discards any cached set carrying an older stamp.
   */
  private async bumpPermissionVersion(
    trx: Parameters<AuditService['write']>[0], orgId: string, userId: string,
  ): Promise<void> {
    await trx
      .updateTable('app.users')
      .set((eb) => ({ permission_version: eb('permission_version', '+', 1) }))
      .where('id', '=', userId)
      .execute();
    this.permissions.invalidate(orgId, userId);
  }

  // ── Invitations ──────────────────────────────────────────────────
  async invite(
    actor: Actor,
    input: { name: string; email?: string; phone?: string;
             grants: Array<{ roleId: string; scopeType: string; scopeId?: string }> },
  ) {
    const token = this.crypto.generateToken();
    const invite = await withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const row = await trx.insertInto('app.invitations').values({
        org_id: actor.orgId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        user_type: 'internal',
        // Only the hash is stored: a leaked table must not yield usable invites.
        token_hash: this.crypto.hashToken(token),
        expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        invited_by: actor.userId,
        pending_grants: JSON.stringify(input.grants),
        created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'invitation', entityId: row.id, action: 'create',
        changes: this.audit.diff(null, { name: row.name, email: row.email, phone: row.phone }),
        context: { grants: input.grants.length, expires_at: row.expires_at },
      });
      return row;
    });

    // The raw token is returned exactly once, here. It is never stored and
    // never retrievable again; a lost invitation is re-sent, not recovered.
    return { id: invite.id, expires_at: invite.expires_at, token };
  }

  async revokeInvitation(actor: Actor, id: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.invitations').selectAll()
          .where('id', '=', id).where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null).executeTakeFirst(),
        'Invitation',
      );
      await trx.updateTable('app.invitations')
        .set({ revoked_at: new Date(), revoked_by: actor.userId })
        .where('id', '=', id).execute();
      await this.audit.write(trx, actor.orgId, {
        entityType: 'invitation', entityId: id, action: 'delete',
        context: { name: before.name },
      });
      return { revoked: true };
    });
  }
}
