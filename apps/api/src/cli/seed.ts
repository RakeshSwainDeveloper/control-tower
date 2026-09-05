import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { withTenant } from '@ct/db';
import type { Kysely } from 'kysely';
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

  // A placeholder project id so project-scoped grants are real. The projects
  // table arrives in Phase 3; the grant shape is already correct.
  const demoProjectId = '00000000-0000-7000-8000-00000000dead';
  const passwordHash = await crypto.hashPassword(DEMO_PASSWORD);

  const created = await withTenant(db, { orgId }, async (trx) => {
    const out: Array<{ key: string; id: string; login: string }> = [];
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

      await trx.insertInto('app.role_grants').values({
        org_id: orgId,
        user_id: user.id,
        role_id: roleIds[p.role]!,
        scope_type: p.scope,
        scope_id: p.scope === 'org' ? null : demoProjectId,
        responsibility_label:
          { company_admin: 'Company Admin', management: 'Management',
            project_manager: 'Project Manager', site_engineer: 'Site Engineer',
            site_supervisor: 'Site Supervisor' }[p.role]!,
        granted_by: user.id,
      }).execute();

      await audit.write(trx, orgId, {
        entityType: 'user', entityId: user.id, action: 'create',
        context: { seeded: true, role: p.role, scope: p.scope },
        source: 'system', responsibilityLabel: 'Platform Provisioning',
      });

      out.push({ key: p.key, id: user.id, login: p.email ?? p.phone! });
    }
    return out;
  });

  console.log('\n  Users:');
  for (const u of created) console.log(`    ${u.key.padEnd(11)} ${u.login.padEnd(22)} ${u.id}`);
  console.log(`\n  Password for email logins: ${DEMO_PASSWORD}`);
  console.log(`  Supervisor logs in by phone + OTP (dev code is echoed).\n`);

  await app.close();
}

main().catch((err) => {
  console.error('\n  ✘ Seed failed:', (err as Error).message, '\n');
  process.exit(1);
});
