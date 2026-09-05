import { Injectable, Inject, BadRequestException, GoneException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { SEED_ROLES } from '@ct/contracts';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { CryptoService } from '../auth/crypto.service.js';

interface InvitationIdentity {
  invitation_id: string;
  org_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  pending_grants: Array<{ roleId: string; scopeType: string; scopeId?: string }>;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  /** Read-only preview so the accept screen can greet the invitee by name. */
  async preview(token: string) {
    const inv = await this.resolve(token);
    return {
      name: inv.name,
      email: inv.email,
      phone: inv.phone,
      expires_at: inv.expires_at,
      requires_password: !!inv.email,
    };
  }

  async accept(token: string, password: string | undefined, ip?: string) {
    const inv = await this.resolve(token);

    // An email invitee logs in with a password; a phone invitee logs in with an
    // OTP and never sets one.
    if (inv.email && !password) {
      throw new BadRequestException('A password is required to accept this invitation');
    }

    const passwordHash = password ? await this.crypto.hashPassword(password) : null;

    return withTenant(this.db, { orgId: inv.org_id }, async (trx) => {
      // Re-check inside the transaction: two clicks on the same emailed link
      // must not create two users.
      const live = await trx
        .selectFrom('app.invitations')
        .select(['id', 'accepted_at', 'revoked_at', 'expires_at'])
        .where('id', '=', inv.invitation_id)
        .forUpdate()
        .executeTakeFirst();
      if (!live || live.revoked_at) throw new GoneException('This invitation is no longer valid');
      if (live.accepted_at) throw new GoneException('This invitation has already been accepted');
      if (live.expires_at < new Date()) throw new GoneException('This invitation has expired');

      const user = await trx.insertInto('app.users').values({
        org_id: inv.org_id,
        name: inv.name,
        email: inv.email,
        phone: inv.phone,
        user_type: 'internal',
        password_hash: passwordHash,
        status: 'active',
      }).returningAll().executeTakeFirstOrThrow();

      for (const g of inv.pending_grants ?? []) {
        const role = await trx.selectFrom('app.roles')
          .select(['id', 'code', 'name']).where('id', '=', g.roleId).executeTakeFirst();
        if (!role) continue;   // role deleted since the invite was sent
        await trx.insertInto('app.role_grants').values({
          org_id: inv.org_id,
          user_id: user.id,
          role_id: role.id,
          scope_type: g.scopeType as 'org',
          scope_id: g.scopeId ?? null,
          responsibility_label:
            SEED_ROLES.find((r) => r.code === role.code)?.responsibility ?? role.name,
          granted_by: user.id,
        }).execute();
      }

      await trx.updateTable('app.invitations')
        .set({ accepted_at: new Date(), accepted_user_id: user.id })
        .where('id', '=', inv.invitation_id).execute();

      await this.audit.write(trx, inv.org_id, {
        entityType: 'user', entityId: user.id, action: 'create',
        context: { via: 'invitation', invitation_id: inv.invitation_id, ip: ip ?? null },
        actorUserId: user.id,
        responsibilityLabel: 'Invitee',
      });

      return { user_id: user.id, org_id: inv.org_id, email: user.email, phone: user.phone };
    });
  }

  private async resolve(token: string): Promise<InvitationIdentity> {
    const hash = this.crypto.hashToken(token);
    const r = await withoutTenant(this.db, 'invitation acceptance precedes tenant context', (trx) =>
      sql<InvitationIdentity>`SELECT (app.resolve_invitation_by_token(${hash})).*`.execute(trx),
    );
    const inv = r.rows[0];
    // One message for every failure mode: an invalid token must not reveal
    // whether it never existed, expired, or was already used.
    if (!inv?.invitation_id) throw new GoneException('This invitation is no longer valid');
    if (inv.revoked_at || inv.accepted_at || inv.expires_at < new Date()) {
      throw new GoneException('This invitation is no longer valid');
    }
    return inv;
  }
}
