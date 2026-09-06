import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { withTenant } from '@ct/db';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@ct/db';
import { AppModule } from '../app.module.js';
import { DB_TOKEN } from '../common/tokens.js';
import { ProvisioningService } from '../modules/tenancy/provisioning.service.js';
import { CryptoService } from '../modules/auth/crypto.service.js';
import { AuditService } from '../common/audit.service.js';

/**
 * Demo tenant for local development and verification.
 *
 * Mirrors journey J7 in MVP_USER_JOURNEYS.md: one company, five people, the
 * five preset roles, grants scoped so the SoD and scoping rules are actually
 * exercised rather than merely present.
 *
 * Idempotent: re-running replaces the tenant rather than erroring, so `make
 * seed` is safe to repeat.
 */
const SLUG = 'demo-construction';

const PEOPLE = [
  { key: 'admin',      name: 'Nikhil Rao',   email: 'nikhil@demo.test',  role: 'company_admin',   scope: 'org' as const },
  { key: 'management', name: 'Mr. Mehta',    email: 'mehta@demo.test',   role: 'management',      scope: 'org' as const },
  { key: 'pm',         name: 'Vikram Shah',  email: 'vikram@demo.test',  role: 'project_manager', scope: 'project' as const },
  { key: 'engineer',   name: 'Anita Desai',  email: 'anita@demo.test',   role: 'site_engineer',   scope: 'project' as const },
  { key: 'supervisor', name: 'Ramesh Kumar', phone: '+919000000001',     role: 'site_supervisor', scope: 'project' as const },
];

const DEMO_PASSWORD = 'Demo!Passw0rd';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Kysely<DB>>(DB_TOKEN);
  const provisioning = app.get(ProvisioningService);
  const crypto = app.get(CryptoService);
  const audit = app.get(AuditService);

  // ── Platform owner (Super Admin) ────────────────────────────────
  // A separate identity domain from tenant users: different table, different
  // login endpoint, no org. Idempotent so `make seed` can be re-run.
  const platformEmail = process.env['PLATFORM_BOOTSTRAP_EMAIL'];
  const platformPassword = process.env['PLATFORM_BOOTSTRAP_PASSWORD'];
  if (platformEmail && platformPassword) {
    const hash = await crypto.hashPassword(platformPassword);
    const pu = await db
      .insertInto('app.platform_users')
      .values({
        email: platformEmail, name: 'Platform Owner',
        password_hash: hash, platform_role: 'platform_owner',
      })
      .onConflict((oc) => oc.column('email').doUpdateSet({ password_hash: hash }))
      .returning(['id', 'email', 'platform_role'])
      .executeTakeFirstOrThrow();
    console.log(`  ✔ platform user  ${pu.email} (${pu.platform_role})`);
  }

  // Idempotency: drop any previous demo tenant. ON DELETE CASCADE from
  // organizations clears users, roles and grants; audit rows survive by design.
  const prior = await db
    .selectFrom('app.organizations').select('id').where('slug', '=', SLUG).executeTakeFirst();
  if (prior) {
    await withTenant(db, { orgId: prior.id }, async (trx) => {
      // Order matters: invitations reference users (accepted_user_id), and
      // grants reference both users and roles.
      await trx.deleteFrom('app.role_grants').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.role_permissions').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.user_sessions').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.otp_challenges').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.invitations').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.org_feature_flags').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.users').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.roles').where('org_id', '=', prior.id).execute();
      await trx.deleteFrom('app.companies').where('org_id', '=', prior.id).execute();
    });
    await db.deleteFrom('app.impersonation_sessions').where('target_org_id', '=', prior.id).execute();
    await db.deleteFrom('app.organizations').where('id', '=', prior.id).execute();
    console.log('  · removed previous demo tenant');
  }

  const { orgId, companyId, roleIds } = await provisioning.provisionOrganization({
    legalName: 'Demo Construction Pvt Ltd',
    displayName: 'Demo Construction',
    slug: SLUG,
  });
  console.log(`  ✔ organization  ${orgId}`);
  console.log(`  ✔ company       ${companyId}`);
  console.log(`  ✔ roles         ${Object.keys(roleIds).join(', ')}`);

  await db.updateTable('app.organizations').set({ status: 'active' }).where('id', '=', orgId).execute();

  const passwordHash = await crypto.hashPassword(DEMO_PASSWORD);

  /**
   * Users, then a REAL project, then the grants that point at it.
   *
   * Until Phase 7 this seeded project-scoped grants against a hardcoded
   * placeholder id — correct when written, because the projects table did not
   * exist until Phase 3, and never revisited afterwards. The result was a demo
   * tenant whose project manager held 34 permissions on a project that was not
   * there: /projects returned nothing, and the entire site surface could not be
   * opened, demonstrated or tested end to end.
   *
   * The ordering is forced by the schema — a project needs an accountable
   * manager — so the people come first.
   */
  const seeded = await withTenant(db, { orgId }, async (trx) => {
    const users: Array<{ key: string; id: string; login: string; role: string; scope: string }> = [];
    for (const p of PEOPLE) {
      const user = await trx.insertInto('app.users').values({
        org_id: orgId,
        name: p.name,
        email: p.email ?? null,
        phone: p.phone ?? null,
        user_type: 'internal',
        password_hash: p.email ? passwordHash : null,
        status: 'active',
      }).returning(['id']).executeTakeFirstOrThrow();

      await audit.write(trx, orgId, {
        entityType: 'user', entityId: user.id, action: 'create',
        context: { seeded: true, role: p.role, scope: p.scope },
        source: 'system', responsibilityLabel: 'Platform Provisioning',
      });

      users.push({ key: p.key, id: user.id, login: p.email ?? p.phone!, role: p.role, scope: p.scope });
    }

    const pm = users.find((u) => u.key === 'pm')!;
    const admin = users.find((u) => u.key === 'admin')!;

    const project = await trx.insertInto('app.projects').values({
      org_id: orgId, company_id: companyId,
      code: 'TWR', name: 'Tower B — Residential',
      description: 'Demo project: 8 floors, 4 flats per floor.',
      accountable_manager_user_id: pm.id,
      commercial_owner_user_id: pm.id,
      // state_class, not a status label: the label is tenant-configurable and
      // the semantics are not (MVP_DATABASE_SCOPE §4).
      state_class: 'in_progress',
      created_by: admin.id,
    }).returning(['id']).executeTakeFirstOrThrow();

    for (const u of users) {
      await trx.insertInto('app.role_grants').values({
        org_id: orgId,
        user_id: u.id,
        role_id: roleIds[u.role]!,
        scope_type: u.scope as 'org',
        scope_id: u.scope === 'org' ? null : project.id,
        responsibility_label:
          { company_admin: 'Company Admin', management: 'Management',
            project_manager: 'Project Manager', site_engineer: 'Site Engineer',
            site_supervisor: 'Site Supervisor' }[u.role]!,
        granted_by: admin.id,
      }).execute();
    }

    // A location tree a supervisor would recognise: floors, then flats, then
    // rooms. Three levels, because that is where a picker starts to hurt and a
    // two-level demo hides the problem.
    for (let f = 1; f <= 8; f++) {
      const floor = await trx.insertInto('app.locations').values({
        org_id: orgId, project_id: project.id, parent_id: null,
        code: `L${f}`, name: `Floor ${f}`, level_name: 'Floor',
        sort_order: f, path: sql`''::ltree` as never, created_by: admin.id,
      }).returning(['id']).executeTakeFirstOrThrow();

      for (let flat = 1; flat <= 4; flat++) {
        const no = f * 100 + flat;
        const unit = await trx.insertInto('app.locations').values({
          org_id: orgId, project_id: project.id, parent_id: floor.id,
          code: `F${no}`, name: `Flat ${no}`, level_name: 'Flat',
          sort_order: flat, path: sql`''::ltree` as never, created_by: admin.id,
        }).returning(['id']).executeTakeFirstOrThrow();

        for (const [i, room] of ['Living', 'Bedroom', 'Kitchen', 'Bathroom'].entries()) {
          await trx.insertInto('app.locations').values({
            org_id: orgId, project_id: project.id, parent_id: unit.id,
            code: `F${no}-${room.slice(0, 3).toUpperCase()}`, name: room, level_name: 'Room',
            sort_order: i, path: sql`''::ltree` as never, created_by: admin.id,
          }).execute();
        }
      }
    }

    const units = await trx.selectFrom('app.units').select(['id', 'code']).execute();
    const unitId = (code: string) => units.find((u) => u.code === code)?.id ?? units[0]!.id;

    const WORK = [
      ['WI-BLK', 'Blockwork 200mm', 'sqm', '3200'],
      ['WI-PLI', 'Internal wall plaster 12mm', 'sqm', '5400'],
      ['WI-PLE', 'External wall plaster 15mm', 'sqm', '2100'],
      ['WI-TIL', 'Floor tiling 600x600', 'sqm', '1850'],
      ['WI-PNT', 'Internal painting — 2 coats', 'sqm', '5400'],
      ['WI-ELE', 'Electrical conduiting', 'm', '4200'],
      ['WI-PLM', 'Plumbing rough-in', 'm', '1600'],
    ] as const;

    for (const [code, description, unit, qty] of WORK) {
      await trx.insertInto('app.work_items').values({
        org_id: orgId, project_id: project.id,
        code, description, unit_id: unitId(unit),
        planned_qty: qty, is_active: true, created_by: admin.id,
      }).execute();
    }

    /**
     * An approval workflow for the daily report.
     *
     * Without one, BR-22 refuses every submission and the approval half of the
     * product is unreachable — which is exactly the state the demo tenant was
     * in until Phase 7. `MVP_IMPLEMENTATION_PLAN.md` lists "seeded default
     * configuration" as an MVP deliverable; this is part of it.
     */
    const def = await trx.insertInto('app.approval_definitions').values({
      org_id: orgId, object_type: 'daily_report', scope_type: 'org', scope_id: null,
      name: 'Daily report sign-off', is_active: true, created_by: admin.id,
    }).returning(['id']).executeTakeFirstOrThrow();

    await trx.insertInto('app.approval_versions').values({
      org_id: orgId, definition_id: def.id, version_no: 1,
      spec: JSON.stringify([
        { step_no: 1, name: 'Project Manager approval',
          resolver: 'project_manager', sla_hours: 24 },
      ]),
      activated_by: admin.id,
    }).execute();

    await audit.write(trx, orgId, {
      entityType: 'project', entityId: project.id, action: 'create',
      projectId: project.id,
      context: { seeded: true, locations: 168, work_items: WORK.length },
      source: 'system', responsibilityLabel: 'Platform Provisioning',
    });

    return { users, projectId: project.id, workItems: WORK.length };
  });

  console.log(`  ✔ project       TWR · Tower B — Residential  ${seeded.projectId}`);
  console.log('  ✔ locations     168 (8 floors · 4 flats each · 4 rooms each)');
  console.log(`  ✔ work items    ${seeded.workItems}`);

  console.log('\n  Users:');
  for (const u of seeded.users) console.log(`    ${u.key.padEnd(11)} ${u.login.padEnd(22)} ${u.id}`);
  console.log(`\n  Tenant email logins: ${DEMO_PASSWORD}`);
  console.log('  Supervisor signs in by phone + OTP (the dev code is echoed).');
  console.log('  Platform admin uses PLATFORM_BOOTSTRAP_EMAIL / _PASSWORD from .env,');
  console.log('  NOT the tenant password above.\n');

  await app.close();
}

main().catch((err) => {
  console.error('\n  ✘ Seed failed:', (err as Error).message, '\n');
  process.exit(1);
});
