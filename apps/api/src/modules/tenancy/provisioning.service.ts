import { Injectable, Inject, ConflictException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  SEED_ROLES, SEED_UNITS, SEED_WORK_CATEGORIES,
  SEED_ISSUE_CATEGORIES, SEED_STATUSES,
} from '@ct/contracts';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';

export interface ProvisionOrgInput {
  legalName: string;
  displayName: string;
  slug: string;
  country?: string;
  timezone?: string;
  dataRegion?: string;
}

export interface ProvisionedOrg {
  orgId: string;
  companyId: string;
  roleIds: Record<string, string>;
}

/**
 * Creates a tenant: organization + its default company + the five system roles.
 *
 * All of it in ONE transaction. A half-provisioned tenant — an org with no
 * roles, say — is worse than none: the first admin logs in and can grant
 * nothing, and diagnosing it means reading the schema.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
  ) {}

  async provisionOrganization(input: ProvisionOrgInput): Promise<ProvisionedOrg> {
    const existing = await withoutTenant(this.db, 'slug uniqueness precedes tenant context', (trx) =>
      trx.selectFrom('app.organizations').select('id').where('slug', '=', input.slug).executeTakeFirst(),
    );
    if (existing) throw new ConflictException(`Organization slug '${input.slug}' is already taken`);

    // The org row itself must exist before RLS can scope anything to it.
    const org = await withoutTenant(this.db, 'creating a tenant precedes its own context', (trx) =>
      trx
        .insertInto('app.organizations')
        .values({
          legal_name: input.legalName,
          display_name: input.displayName,
          slug: input.slug,
          country: input.country ?? 'IN',
          timezone: input.timezone ?? 'Asia/Kolkata',
          data_region: input.dataRegion ?? 'ap-south-1',
          status: 'trial',
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    // Everything else is tenant data and runs under tenant context.
    return withTenant(this.db, { orgId: org.id }, async (trx) => {
      const company = await trx
        .insertInto('app.companies')
        .values({
          org_id: org.id,
          name: input.displayName,
          is_default: true,   // hidden from the MVP UI (FR-003)
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const roleIds: Record<string, string> = {};
      for (const seed of SEED_ROLES) {
        const role = await trx
          .insertInto('app.roles')
          .values({
            org_id: org.id,
            code: seed.code,
            name: seed.name,
            description: seed.description,
            is_system: true,
            is_external: seed.isExternal,
            applicable_scope_levels: seed.scopeLevels,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        roleIds[seed.code] = role.id;

        await trx
          .insertInto('app.role_permissions')
          .values(
            seed.permissions.map(([key, qualifier]) => ({
              org_id: org.id,
              role_id: role.id,
              permission_key: key,
              record_qualifier: qualifier ?? ('all_in_scope' as const),
            })),
          )
          .execute();
      }

      // ── Masters every project needs on day one ────────────────
      // FR-544: a tenant that never opens a configuration screen must still
      // have a working system. Shipping an org with no units means the first
      // work item cannot be created.
      await trx.insertInto('app.units').values(
        SEED_UNITS.map((u) => ({
          org_id: org.id, code: u.code, name: u.name,
          dimension: u.dimension, decimal_places: u.decimals,
        })),
      ).execute();

      await trx.insertInto('app.master_data').values(
        SEED_WORK_CATEGORIES.map((c, i) => ({
          org_id: org.id, kind: 'work_category', code: c.code, name: c.name, sort_order: i,
        })).concat(
          SEED_ISSUE_CATEGORIES.map((c, i) => ({
            org_id: org.id, kind: 'issue_category', code: c.code, name: c.name, sort_order: i,
          })),
        ),
      ).execute();

      // Statuses: label = state_class in the MVP, and no editor ships.
      // The table exists so Phase 2 turns the editor on with no schema change.
      await trx.insertInto('app.statuses').values(
        SEED_STATUSES.map((s, i) => ({
          org_id: org.id, entity_type: s.entity, code: s.cls, label: s.label,
          state_class: s.cls, sort_order: i,
          is_default: s.isDefault ?? false, is_terminal: s.isTerminal ?? false,
        })),
      ).execute();

      await trx.insertInto('app.numbering_series').values([
        { org_id: org.id, entity_type: 'daily_report', prefix: 'DR', include_project_code: true },
        { org_id: org.id, entity_type: 'issue',        prefix: 'ISS', include_project_code: true },
      ]).execute();

      await this.audit.write(trx, org.id, {
        entityType: 'organization',
        entityId: org.id,
        action: 'create',
        changes: this.audit.diff(null, {
          legal_name: org.legal_name, display_name: org.display_name,
          slug: org.slug, status: org.status,
        }),
        context: {
          seeded_roles: Object.keys(roleIds), default_company_id: company.id,
          seeded_units: SEED_UNITS.length,
          seeded_statuses: SEED_STATUSES.length,
        },
        source: 'system',
        responsibilityLabel: 'Platform Provisioning',
      });

      return { orgId: org.id, companyId: company.id, roleIds };
    });
  }
}
