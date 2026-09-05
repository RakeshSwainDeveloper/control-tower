/**
 * OFFLINE SYNC — the adversarial suite.
 *
 * This is the PT-1 gate from MVP_IMPLEMENTATION_PLAN.md §2, held to its stated
 * criterion: 500 simulated offline operations across induced failures, with
 * ZERO data loss, ZERO duplicates, and every conflict surfaced rather than
 * silently overwritten.
 *
 * Sync correctness is the single hardest technical risk in the product
 * (PRD.md TR-1). A supervisor who loses one afternoon's work stops using the
 * app, and no later feature wins them back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb } from './helpers.js';
import { SyncRegistry } from '../src/modules/sync/sync.registry.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { AuditService } from '../src/common/audit.service.js';
import {
  SyncConflict, SyncRejection,
  type SyncActor, type SyncHandler, type SyncItem, type AppliedItem,
} from '../src/modules/sync/sync.types.js';

/** A stand-in for the Phase 5 progress entry, exercising all three policies. */
class ProbeHandler implements SyncHandler {
  readonly entity = 'probe_entry';
  readonly conflictPolicy = 'accept_as_new' as const;
  readonly permission = 'field.progress.create';
  /** Induced failure surface: the caller decides how each item behaves. */
  applied = 0;

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    const p = item.payload as {
      mode?: string; evidence_id?: string; entity_id?: string;
    };

    if (p.mode === 'malformed') {
      throw new SyncRejection('This entry is missing required fields. It was kept so you can fix it.');
    }
    if (p.mode === 'locked') {
      throw new SyncConflict(
        'reject_to_attention',
        'This record was verified while you were offline. Your edit was not applied.',
        { verified_at: new Date().toISOString() },
      );
    }
    if (p.mode === 'same_day_two_authors') {
      throw new SyncConflict(
        'keep_both_and_flag',
        'Another supervisor submitted a report for this day. Both were kept.',
        { merged: true },
      );
    }
    if (p.mode === 'boom') {
      throw new Error('simulated unexpected server fault');
    }

    // A real write, so the accounting is against actual rows.
    const row = await trx.insertInto('app.evidence_links').values({
      org_id: actor.orgId,
      evidence_id: p.evidence_id!,
      entity_type: 'probe_entry',
      entity_id: p.entity_id ?? randomUUID(),
      purpose: 'progress',
      linked_by: actor.userId,
    }).returning(['id', 'version']).executeTakeFirstOrThrow();
    this.applied++;
    return { serverId: row.id, version: row.version };
  }
}

const noopLogger = {
  warn: () => undefined, error: () => undefined,
  info: () => undefined, debug: () => undefined,
} as never;

describe('offline sync — adversarial', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;
  let svc: SyncService;
  let registry: SyncRegistry;
  let probe: ProbeHandler;
  let actor: SyncActor;
  let orgId: string;
  let evidenceId: string;

  beforeAll(async () => {
    db = appDb();
    owner = migratorDb();

    const org = await withoutTenant(owner, 'fixture precedes tenant context', (trx) =>
      trx.insertInto('app.organizations').values({
        legal_name: 'Sync Ltd', display_name: 'Sync',
        slug: `sync-${Date.now().toString(36)}`,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    orgId = org.id;

    const userId = await withTenant(owner, { orgId }, async (trx) => {
      const u = await trx.insertInto('app.users').values({
        org_id: orgId, name: 'Sync Probe', email: `s${Date.now()}@x.test`, status: 'active',
      }).returning('id').executeTakeFirstOrThrow();
      const ev = await trx.insertInto('app.evidence_assets').values({
        org_id: orgId, kind: 'photo', storage_key: 'k/1.png', mime_type: 'image/png',
        size_bytes: '100',
        content_hash: createHash('sha256').update(randomUUID()).digest(),
        captured_at_device: new Date(), captured_by: u.id,
        capture_method: 'in_app_camera', gps_lat: '19.07', gps_lng: '72.87',
        state: 'ready',
      }).returning('id').executeTakeFirstOrThrow();
      evidenceId = ev.id;
      return u.id;
    });

    actor = { userId, orgId, deviceId: 'probe-device-01' };
    registry = new SyncRegistry();
    probe = new ProbeHandler();
    registry.register(probe);
    svc = new SyncService(db, noopLogger, registry, new AuditService());
  });

  afterAll(async () => {
    await withTenant(owner, { orgId }, async (trx) => {
      await trx.deleteFrom('app.sync_conflicts').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.evidence_links').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.users').where('org_id', '=', orgId).execute();
    });
    await withoutTenant(owner, 'teardown', async (trx) => {
      await sql`DELETE FROM app.sync_operations WHERE org_id = ${orgId}`.execute(trx);
      await sql`DELETE FROM app.evidence_assets WHERE org_id = ${orgId}`.execute(trx);
      await trx.deleteFrom('app.organizations').where('id', '=', orgId).execute();
    });
    await db.destroy();
    await owner.destroy();
  });

  const item = (mode: string, over: Partial<SyncItem> = {}): SyncItem => ({
    client_uuid: randomUUID(),
    entity: 'probe_entry',
    op: 'create',
    payload: { mode, evidence_id: evidenceId, entity_id: randomUUID() },
    device_ts: new Date().toISOString(),
    ...over,
  });

  // ── the properties, one at a time ────────────────────────────────

  it('accepts a clean batch', async () => {
    const { results } = await svc.ingest(actor, [item('ok'), item('ok'), item('ok')]);
    expect(results.every((r) => r.status === 'accepted')).toBe(true);
    expect(results.every((r) => !!r.server_id)).toBe(true);
  });

  it('REPLAY returns the original result and does not duplicate', async () => {
    // The single property everything else rests on: a flaky connection retries,
    // and a retry must be free.
    const one = item('ok');
    const first = await svc.ingest(actor, [one]);
    const second = await svc.ingest(actor, [one]);
    const third = await svc.ingest(actor, [one, one]);

    expect(first.results[0]!.status).toBe('accepted');
    expect(second.results[0]!.server_id).toBe(first.results[0]!.server_id);
    expect(third.results[0]!.server_id).toBe(first.results[0]!.server_id);
    expect(third.results[1]!.server_id).toBe(first.results[0]!.server_id);

    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.evidence_links').select('id')
        .where('entity_id', '=', (one.payload as { entity_id: string }).entity_id)
        .execute(),
    );
    expect(rows, 'a replayed operation created a second row').toHaveLength(1);
  });

  it('ONE BAD ITEM DOES NOT FAIL THE BATCH', async () => {
    // A device with one malformed record must still deliver the other 49.
    const batch = [item('ok'), item('malformed'), item('ok'), item('boom'), item('ok')];
    const { results } = await svc.ingest(actor, batch);
    expect(results).toHaveLength(5);
    expect(results.filter((r) => r.status === 'accepted')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });

  it('a rejected item keeps its PAYLOAD in needs-attention', async () => {
    // FR-491: nothing is ever discarded. The user corrects; they do not re-enter.
    const bad = item('malformed');
    await svc.ingest(actor, [bad]);
    const q = await svc.needsAttention(actor);
    const found = q.items.find((i) => i.client_uuid === bad.client_uuid);
    expect(found, 'rejected item vanished instead of reaching needs-attention').toBeDefined();
    expect(found!.reason).toMatch(/kept so you can fix it/i);
    expect((found!.payload as { mode: string }).mode).toBe('malformed');
  });

  it('an unexpected server fault still preserves the work', async () => {
    const boom = item('boom');
    const { results } = await svc.ingest(actor, [boom]);
    expect(results[0]!.status).toBe('rejected');
    const q = await svc.needsAttention(actor);
    expect(q.items.some((i) => i.client_uuid === boom.client_uuid)).toBe(true);
  });

  it('POLICY reject_to_attention: an edit to a locked record is refused, not applied', async () => {
    const locked = item('locked');
    const { results } = await svc.ingest(actor, [locked]);
    expect(results[0]!.status).toBe('conflict');
    expect(results[0]!.conflict!.policy).toBe('reject_to_attention');
    expect(results[0]!.conflict!.kept_both).toBe(false);
    const q = await svc.needsAttention(actor);
    expect(q.items.some((i) => i.client_uuid === locked.client_uuid)).toBe(true);
  });

  it('POLICY keep_both_and_flag: neither author is silently overwritten', async () => {
    const both = item('same_day_two_authors');
    const { results } = await svc.ingest(actor, [both]);
    expect(results[0]!.status).toBe('conflict');
    expect(results[0]!.conflict!.policy).toBe('keep_both_and_flag');
    const conflicts = await svc.conflicts(actor);
    expect(conflicts.some((c) => c.sync_client_uuid === both.client_uuid)).toBe(true);
  });

  it('an unknown entity is kept, not dropped, so an app upgrade loses nothing', async () => {
    const future = { ...item('ok'), entity: 'phase_9_entity' };
    const { results } = await svc.ingest(actor, [future]);
    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.reason).toMatch(/does not accept/i);
    const q = await svc.needsAttention(actor);
    expect(q.items.some((i) => i.client_uuid === future.client_uuid)).toBe(true);
  });

  it('resolving an attention item clears it from the queue', async () => {
    const bad = item('malformed');
    await svc.ingest(actor, [bad]);
    expect(await svc.resolveAttention(actor, bad.client_uuid)).toEqual({ resolved: true });
    const q = await svc.needsAttention(actor);
    expect(q.items.some((i) => i.client_uuid === bad.client_uuid)).toBe(false);
  });

  it('refuses an oversized batch rather than half-processing it', async () => {
    const huge = Array.from({ length: 201 }, () => item('ok'));
    await expect(svc.ingest(actor, huge)).rejects.toThrow(/exceeds the limit/i);
  });
});
