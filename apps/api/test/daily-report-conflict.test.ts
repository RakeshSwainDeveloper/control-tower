/**
 * KEEP_BOTH_AND_FLAG, against real rows.
 *
 * Phase 4 implemented and unit-tested this policy but noted its first REAL
 * consumer arrived with the daily report header. This is that consumer.
 *
 * The situation: two supervisors, both offline, both submit a report for the
 * same project and the same day. Neither is wrong. Last-write-wins would
 * silently destroy one person's afternoon, and picking a winner by timestamp is
 * arbitrary when both devices had wrong clocks. So both are kept, both are
 * flagged, and the project manager decides.
 *
 * The system's job here is to refuse to guess.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb } from './helpers.js';
import { SyncRegistry } from '../src/modules/sync/sync.registry.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { DailyReportSyncHandler } from '../src/modules/progress/daily-report.sync-handler.js';
import { PermissionService } from '../src/modules/access/permission.service.js';
import { AuditService } from '../src/common/audit.service.js';
import { SEED_ROLES } from '@ct/contracts';
import type { SyncActor, SyncItem } from '../src/modules/sync/sync.types.js';

const noopLogger = {
  warn: () => undefined, error: () => undefined,
  info: () => undefined, debug: () => undefined,
} as never;

describe('daily report · keep_both_and_flag', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;
  let svc: SyncService;
  let orgId: string;
  let projectId: string;
  let ramesh: SyncActor;
  let suresh: SyncActor;
  const DAY = '2026-09-01';

  beforeAll(async () => {
    db = appDb();
    owner = migratorDb();

    const org = await withoutTenant(owner, 'fixture precedes tenant context', (trx) =>
      trx.insertInto('app.organizations').values({
        legal_name: 'TwoAuthors Ltd', display_name: 'TwoAuthors',
        slug: `two-${Date.now().toString(36)}`,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    orgId = org.id;

    const ids = await withTenant(owner, { orgId }, async (trx) => {
      const company = await trx.insertInto('app.companies')
        .values({ org_id: orgId, name: 'TwoAuthors', is_default: true })
        .returning('id').executeTakeFirstOrThrow();

      // The site supervisor role, so both users genuinely hold the permission
      // the handler re-checks at sync time.
      const seed = SEED_ROLES.find((r) => r.code === 'site_supervisor')!;
      const role = await trx.insertInto('app.roles').values({
        org_id: orgId, code: seed.code, name: seed.name, is_system: true,
        applicable_scope_levels: ['project'],
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('app.role_permissions').values(
        seed.permissions.map(([key, q]) => ({
          org_id: orgId, role_id: role.id, permission_key: key,
          record_qualifier: (q ?? 'all_in_scope') as 'all_in_scope',
        })),
      ).execute();

      const users: string[] = [];
      for (const name of ['Ramesh', 'Suresh']) {
        const u = await trx.insertInto('app.users').values({
          org_id: orgId, name, email: `${name.toLowerCase()}-${Date.now()}@x.test`,
          status: 'active',
        }).returning('id').executeTakeFirstOrThrow();
        users.push(u.id);
      }

      const project = await trx.insertInto('app.projects').values({
        org_id: orgId, company_id: company.id, code: 'TWO', name: 'Two Authors',
        accountable_manager_user_id: users[0]!, commercial_owner_user_id: users[0]!,
      }).returning('id').executeTakeFirstOrThrow();

      for (const uid of users) {
        await trx.insertInto('app.role_grants').values({
          org_id: orgId, user_id: uid, role_id: role.id,
          scope_type: 'project', scope_id: project.id,
          responsibility_label: 'Site Supervisor', granted_by: uid,
        }).execute();
      }
      return { projectId: project.id, users };
    });

    projectId = ids.projectId;
    ramesh = { userId: ids.users[0]!, orgId, deviceId: 'phone-ramesh' };
    suresh = { userId: ids.users[1]!, orgId, deviceId: 'phone-suresh' };

    const registry = new SyncRegistry();
    const perms = new PermissionService(db);
    const audit = new AuditService();
    registry.register(new DailyReportSyncHandler(registry, perms, audit) as never);
    svc = new SyncService(db, noopLogger, registry, audit);
  });

  afterAll(async () => {
    await withTenant(owner, { orgId }, async (trx) => {
      await trx.deleteFrom('app.sync_conflicts').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.daily_reports').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.role_grants').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.role_permissions').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.projects').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.roles').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.users').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.companies').where('org_id', '=', orgId).execute();
    });
    await withoutTenant(owner, 'teardown', async (trx) => {
      await sql`DELETE FROM app.sync_operations WHERE org_id = ${orgId}`.execute(trx);
      await trx.deleteFrom('app.organizations').where('id', '=', orgId).execute();
    });
    await db.destroy();
    await owner.destroy();
  });

  const report = (weather: string): SyncItem => ({
    client_uuid: randomUUID(),
    entity: 'daily_report',
    op: 'create',
    payload: { project_id: projectId, report_date: DAY, weather, notes: `by ${weather}` },
    device_ts: new Date().toISOString(),
  });

  it('the first author to sync creates the original', async () => {
    const { results } = await svc.ingest(ramesh, [report('Clear')]);
    expect(results[0]!.status).toBe('accepted');
    expect(results[0]!.conflict).toBeUndefined();
  });

  it('the SECOND author is KEPT, not overwritten', async () => {
    const item = report('Rain');
    const { results } = await svc.ingest(suresh, [item]);
    const r = results[0]!;

    expect(r.status).toBe('conflict');
    expect(r.conflict!.policy).toBe('keep_both_and_flag');
    expect(r.conflict!.kept_both, 'the second submission was discarded').toBe(true);
    expect(r.conflict!.other_id, 'the twin does not point at the original').toBeTruthy();
    expect(r.server_id, 'the second author got no row at all').toBeTruthy();
  });

  it('BOTH reports exist for the day, and BOTH are flagged', async () => {
    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.daily_reports')
        .select(['id', 'weather', 'created_by', 'merged_from_report_id', 'has_merge_conflict'])
        .where('project_id', '=', projectId).where('report_date', '=', DAY)
        .orderBy('created_at').execute(),
    );

    expect(rows, 'one author lost their report').toHaveLength(2);
    expect(rows.map((r) => r.weather).sort()).toEqual(['Clear', 'Rain']);
    expect(rows[0]!.created_by).toBe(ramesh.userId);
    expect(rows[1]!.created_by).toBe(suresh.userId);

    // The twin points back at the original…
    expect(rows[1]!.merged_from_report_id).toBe(rows[0]!.id);
    // …and BOTH carry the flag. Flagging only the newcomer would leave whoever
    // opens the first report unaware there is a second.
    expect(rows[0]!.has_merge_conflict, 'the original was not flagged').toBe(true);
    expect(rows[1]!.has_merge_conflict).toBe(true);
  });

  it('the conflict is recorded for the project manager', async () => {
    const conflicts = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.sync_conflicts')
        .select(['policy_applied', 'kept_both', 'other_entity_id', 'entity_type'])
        .where('org_id', '=', orgId).execute(),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.policy_applied).toBe('keep_both_and_flag');
    expect(conflicts[0]!.kept_both).toBe(true);
    expect(conflicts[0]!.entity_type).toBe('daily_report');
  });

  it('the SAME author syncing twice updates in place — that is not a conflict', async () => {
    // A device catching up with itself must not manufacture a twin.
    const again = report('Overcast');
    again.payload = { ...(again.payload as object), report_date: '2026-09-02' };
    await svc.ingest(ramesh, [again]);

    const second = report('Overcast then clear');
    second.payload = { ...(second.payload as object), report_date: '2026-09-02' };
    const { results } = await svc.ingest(ramesh, [second]);

    expect(results[0]!.status).toBe('accepted');
    expect(results[0]!.conflict).toBeUndefined();

    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.daily_reports').select(['id', 'weather'])
        .where('project_id', '=', projectId).where('report_date', '=', '2026-09-02')
        .execute(),
    );
    expect(rows, 'the same author got a duplicate twin').toHaveLength(1);
    expect(rows[0]!.weather).toBe('Overcast then clear');
  });

  it('a revoked grant is caught at sync time, not trusted from the device', async () => {
    // The phone went offline BEFORE the grant was revoked. What the app
    // believed at capture time is not evidence of current authority.
    await withTenant(owner, { orgId }, (trx) =>
      trx.updateTable('app.role_grants')
        .set({ revoked_at: new Date(), revoked_by: suresh.userId, revoke_reason: 'left the site' })
        .where('user_id', '=', suresh.userId).execute(),
    );
    await withTenant(owner, { orgId }, (trx) =>
      trx.updateTable('app.users')
        .set((eb) => ({ permission_version: eb('permission_version', '+', 1) }))
        .where('id', '=', suresh.userId).execute(),
    );

    const late = report('Sunny');
    late.payload = { ...(late.payload as object), report_date: '2026-09-03' };
    const { results } = await svc.ingest(suresh, [late]);

    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.reason).toMatch(/no longer have permission/i);

    // And it is recoverable, not lost.
    const q = await svc.needsAttention(suresh);
    expect(q.items.some((i) => i.client_uuid === late.client_uuid)).toBe(true);
  });
});
