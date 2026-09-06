/**
 * PT-1 GATE — 500 offline operations across induced failures.
 *
 * MVP_IMPLEMENTATION_PLAN.md §2 states the criterion verbatim:
 *
 *   "500 simulated offline operations across 3 devices with induced failures:
 *    zero loss, zero duplicates, every conflict surfaced and none silently
 *    overwritten."
 *
 * This is a release gate, not a target (NFR-09). A supervisor who loses one
 * afternoon's work stops using the app, and no later feature wins them back.
 *
 * The induced failures model what actually happens on a site: the same batch
 * retried because the response never arrived, a batch delivered twice by two
 * radios, an app killed mid-flush and restarted, records that moved on while
 * the phone was in a basement, and the occasional malformed row.
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

const TOTAL_OPS = 500;
const DEVICES = 3;

interface Plan {
  clientUuid: string;
  device: number;
  mode: 'ok' | 'malformed' | 'locked' | 'same_day_two_authors' | 'boom';
  entityId: string;
  /** How many times the device delivers this operation. */
  deliveries: number;
}

class ProbeHandler implements SyncHandler {
  readonly entity = 'probe_entry';
  readonly conflictPolicy = 'accept_as_new' as const;
  readonly permission = 'field.progress.create';
  evidenceId = '';

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    const p = item.payload as { mode: Plan['mode']; entity_id: string };
    switch (p.mode) {
      case 'malformed':
        throw new SyncRejection('This entry is missing required fields.');
      case 'locked':
        throw new SyncConflict('reject_to_attention',
          'This record was verified while you were offline.');
      case 'same_day_two_authors':
        throw new SyncConflict('keep_both_and_flag',
          'Another supervisor submitted for this day. Both were kept.');
      case 'boom':
        throw new Error('simulated fault');
      default: {
        const row = await trx.insertInto('app.evidence_links').values({
          org_id: actor.orgId, evidence_id: this.evidenceId,
          entity_type: 'probe_entry', entity_id: p.entity_id,
          purpose: 'progress', linked_by: actor.userId,
        }).returning(['id', 'version']).executeTakeFirstOrThrow();
        return { serverId: row.id, version: row.version };
      }
    }
  }
}

const noopLogger = {
  warn: () => undefined, error: () => undefined,
  info: () => undefined, debug: () => undefined,
} as never;

describe('PT-1 · 500 offline operations, 3 devices, induced failures', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;
  let svc: SyncService;
  let probe: ProbeHandler;
  let orgId: string;
  let userId: string;
  const plans: Plan[] = [];
  const resultsByUuid = new Map<string, { status: string; serverId: string | null }>();

  beforeAll(async () => {
    db = appDb();
    owner = migratorDb();

    const org = await withoutTenant(owner, 'fixture precedes tenant context', (trx) =>
      trx.insertInto('app.organizations').values({
        legal_name: 'PT1 Ltd', display_name: 'PT1',
        slug: `pt1-${Date.now().toString(36)}`,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    orgId = org.id;

    probe = new ProbeHandler();
    await withTenant(owner, { orgId }, async (trx) => {
      const u = await trx.insertInto('app.users').values({
        org_id: orgId, name: 'PT1 Supervisor', email: `pt1-${Date.now()}@x.test`,
        status: 'active',
      }).returning('id').executeTakeFirstOrThrow();
      userId = u.id;
      const ev = await trx.insertInto('app.evidence_assets').values({
        org_id: orgId, kind: 'photo', storage_key: 'k/pt1.png', mime_type: 'image/png',
        size_bytes: '100',
        content_hash: createHash('sha256').update(randomUUID()).digest(),
        captured_at_device: new Date(), captured_by: u.id,
        capture_method: 'in_app_camera', gps_lat: '19.07', gps_lng: '72.87',
        state: 'ready',
      }).returning('id').executeTakeFirstOrThrow();
      probe.evidenceId = ev.id;
    });

    const registry = new SyncRegistry();
    registry.register(probe);
    svc = new SyncService(db, noopLogger, registry, new AuditService());

    // ── Build a deterministic plan ────────────────────────────────
    // Deterministic so a failure is reproducible: a flaky sync test that
    // cannot be re-run identically is worse than no test.
    let seed = 20260905;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let i = 0; i < TOTAL_OPS; i++) {
      const r = rand();
      const mode: Plan['mode'] =
        r < 0.72 ? 'ok'
        : r < 0.80 ? 'malformed'
        : r < 0.88 ? 'locked'
        : r < 0.94 ? 'same_day_two_authors'
        : 'boom';
      // ~30% of operations are delivered more than once: a dropped response,
      // a second radio, or an app restart mid-flush.
      const d = rand();
      const deliveries = d < 0.70 ? 1 : d < 0.92 ? 2 : 3;
      plans.push({
        clientUuid: randomUUID(),
        device: i % DEVICES,
        mode,
        entityId: randomUUID(),
        deliveries,
      });
    }
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

  it(`delivers ${TOTAL_OPS} operations from ${DEVICES} devices with retries and duplicates`, async () => {
    // Interleave the three devices' outboxes, and expand retries in place, so
    // duplicate deliveries can arrive adjacent OR far apart.
    const wire: Array<{ plan: Plan; attempt: number }> = [];
    for (const plan of plans) {
      for (let a = 0; a < plan.deliveries; a++) wire.push({ plan, attempt: a });
    }
    let s = 987654321;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = wire.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [wire[i], wire[j]] = [wire[j]!, wire[i]!];
    }

    const byDevice = new Map<number, Array<{ plan: Plan; attempt: number }>>();
    for (const w of wire) {
      const list = byDevice.get(w.plan.device) ?? [];
      list.push(w);
      byDevice.set(w.plan.device, list);
    }

    let delivered = 0;
    for (const [device, queue] of byDevice) {
      const actor: SyncActor = { userId, orgId, deviceId: `pt1-device-${device}` };
      // Realistic batch sizes: a phone flushes what it has when signal returns.
      for (let i = 0; i < queue.length; i += 40) {
        const slice = queue.slice(i, i + 40);
        const items: SyncItem[] = slice.map(({ plan }) => ({
          client_uuid: plan.clientUuid,
          entity: 'probe_entry',
          op: 'create',
          payload: { mode: plan.mode, entity_id: plan.entityId },
          device_ts: new Date().toISOString(),
          clock_skew_ms: device === 2 ? 9 * 60 * 1000 : 120,   // one device has a wrong clock
        }));
        const { results } = await svc.ingest(actor, items);
        expect(results).toHaveLength(items.length);
        for (const r of results) {
          const prior = resultsByUuid.get(r.client_uuid);
          if (prior) {
            // A replay must return the SAME answer, every time.
            expect(r.status, `status changed on replay of ${r.client_uuid}`).toBe(prior.status);
            expect(r.server_id ?? null,
              `server_id changed on replay of ${r.client_uuid}`).toBe(prior.serverId);
          } else {
            resultsByUuid.set(r.client_uuid, { status: r.status, serverId: r.server_id ?? null });
          }
        }
        delivered += items.length;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n    delivered ${delivered} wire operations for ${TOTAL_OPS} distinct ` +
      `client_uuids across ${DEVICES} devices ` +
      `(${delivered - TOTAL_OPS} duplicate deliveries)\n`,
    );
    expect(delivered).toBeGreaterThan(TOTAL_OPS);
  }, 120_000);

  it('ZERO LOSS — every operation has exactly one ledger row', async () => {
    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.sync_operations')
        .select(['client_uuid', 'status']).where('org_id', '=', orgId).execute(),
    );
    const seen = new Set(rows.map((r) => r.client_uuid));
    const missing = plans.filter((p) => !seen.has(p.clientUuid)).map((p) => p.clientUuid);
    expect(missing, `operations with NO ledger row: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
    expect(seen.size).toBe(TOTAL_OPS);
  });

  it('ZERO DUPLICATES — no ledger row appears twice', async () => {
    const dupes = await withTenant(db, { orgId }, async (trx) => {
      const r = await sql<{ client_uuid: string; n: string }>`
        SELECT client_uuid, count(*) AS n FROM app.sync_operations
        WHERE org_id = ${orgId} GROUP BY client_uuid HAVING count(*) > 1
      `.execute(trx);
      return r.rows;
    });
    expect(dupes, `duplicated ledger rows: ${JSON.stringify(dupes.slice(0, 3))}`).toEqual([]);
  });

  it('ZERO DUPLICATES — no entity was written twice', async () => {
    // The one that actually matters to a supervisor: 4 flats recorded, 4 rows.
    const dupes = await withTenant(db, { orgId }, async (trx) => {
      const r = await sql<{ entity_id: string; n: string }>`
        SELECT entity_id, count(*) AS n FROM app.evidence_links
        WHERE org_id = ${orgId} AND entity_type = 'probe_entry'
        GROUP BY entity_id HAVING count(*) > 1
      `.execute(trx);
      return r.rows;
    });
    expect(dupes, `entities written more than once: ${JSON.stringify(dupes.slice(0, 3))}`).toEqual([]);

    const expectedRows = plans.filter((p) => p.mode === 'ok').length;
    const actual = await withTenant(db, { orgId }, async (trx) => {
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM app.evidence_links
        WHERE org_id = ${orgId} AND entity_type = 'probe_entry'
      `.execute(trx);
      return Number(r.rows[0]!.n);
    });
    expect(actual, 'accepted operations did not produce exactly one row each')
      .toBe(expectedRows);
  });

  it('EVERY OUTCOME MATCHES ITS PLAN — nothing silently changed meaning', async () => {
    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.sync_operations')
        .select(['client_uuid', 'status', 'needs_attention'])
        .where('org_id', '=', orgId).execute(),
    );
    const byUuid = new Map(rows.map((r) => [r.client_uuid, r]));
    const expectStatus: Record<Plan['mode'], string> = {
      ok: 'accepted', malformed: 'rejected', boom: 'rejected',
      locked: 'conflict', same_day_two_authors: 'conflict',
    };
    for (const p of plans) {
      const row = byUuid.get(p.clientUuid)!;
      expect(row.status, `${p.mode} produced ${row.status}`).toBe(expectStatus[p.mode]);
    }
  });

  it('NOTHING WAS DISCARDED — every failure is recoverable from needs-attention', async () => {
    const actor: SyncActor = { userId, orgId, deviceId: 'pt1-device-0' };
    const q = await svc.needsAttention(actor, 500);
    const recoverable = new Set(q.data.map((i) => i.client_uuid));

    // Rejections and locked-record conflicts must all be recoverable.
    const shouldRecover = plans.filter(
      (p) => p.mode === 'malformed' || p.mode === 'boom' || p.mode === 'locked',
    );
    const lost = shouldRecover.filter((p) => !recoverable.has(p.clientUuid));
    expect(lost, `unrecoverable operations: ${lost.length}`).toEqual([]);

    // And each carries its payload back, so the user corrects rather than re-enters.
    for (const i of q.data.slice(0, 20)) {
      expect(i.payload, 'a needs-attention item lost its payload').toBeTruthy();
      expect((i.payload as { mode?: string }).mode).toBeTruthy();
    }
  });

  it('EVERY CONFLICT IS SURFACED — none resolved by silent overwrite', async () => {
    const conflicts = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.sync_conflicts')
        .select(['sync_client_uuid', 'policy_applied', 'kept_both'])
        .where('org_id', '=', orgId).execute(),
    );
    const surfaced = new Set(conflicts.map((c) => c.sync_client_uuid));
    const expected = plans.filter(
      (p) => p.mode === 'locked' || p.mode === 'same_day_two_authors',
    );
    const unsurfaced = expected.filter((p) => !surfaced.has(p.clientUuid));
    expect(unsurfaced, `conflicts with no record: ${unsurfaced.length}`).toEqual([]);

    // The policy applied must be the one the situation calls for.
    const byUuid = new Map(conflicts.map((c) => [c.sync_client_uuid, c]));
    for (const p of expected) {
      const c = byUuid.get(p.clientUuid)!;
      expect(c.policy_applied).toBe(
        p.mode === 'locked' ? 'reject_to_attention' : 'keep_both_and_flag',
      );
    }
  });

  it('a device with a wrong clock is recorded, not trusted', async () => {
    const skewed = await withTenant(db, { orgId }, async (trx) => {
      const r = await sql<{ n: string; max_skew: string }>`
        SELECT count(*) AS n, max(abs(clock_skew_ms)) AS max_skew
        FROM app.sync_operations
        WHERE org_id = ${orgId} AND device_id = 'pt1-device-2'
      `.execute(trx);
      return r.rows[0]!;
    });
    expect(Number(skewed.n)).toBeGreaterThan(0);
    // 9 minutes, well past the 5-minute flag threshold, and persisted.
    expect(Number(skewed.max_skew)).toBe(9 * 60 * 1000);
  });
});
