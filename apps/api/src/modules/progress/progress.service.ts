import {
  Injectable, Inject, BadRequestException, ConflictException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { SodService } from '../access/sod.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { CompiledPermissions } from '../access/permission.service.js';

export interface ProgressActor {
  userId: string;
  orgId: string;
  permissions: CompiledPermissions;
}

export interface RecordProgressInput {
  workItemId: string;
  locationId: string;
  reportedQty: string;
  executedOn?: string;
  contractorLabel?: string;
  note?: string;
  overExecutionReason?: string;
  clientUuid?: string;
  deviceClockSkewMs?: number;
}

export interface VerifyInput {
  decision: 'accept' | 'adjust' | 'reject';
  verifiedQty?: string;
  reason?: string;
}

@Injectable()
export class ProgressService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly sod: SodService,
  ) {}

  /**
   * Records a quantity claim, captured at the location.
   *
   * FR-142: the quantity is entered; the PERCENTAGE is derived and never typed.
   * "80% complete" is an opinion. "412 of 515 sqm of plaster in Flat 502" is a
   * fact that can be measured, disputed and verified — and that single rule is
   * what makes every downstream number defensible.
   */
  async record(actor: ProgressActor, projectId: string, input: RecordProgressInput) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.progress.create', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['field.progress.create'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => this.recordInTrx(trx, actor, projectId, input, grant?.grantId, grant?.responsibilityLabel),
    );
  }

  /**
   * Shared by the HTTP path and the sync handler.
   *
   * The offline path must produce a byte-identical record to the online one:
   * two implementations of "record progress" would diverge within a month, and
   * the divergence would only show up in whichever path is less tested.
   */
  async recordInTrx(
    trx: Transaction<DB>,
    actor: ProgressActor,
    projectId: string,
    input: RecordProgressInput,
    grantId?: string,
    responsibility?: string,
  ) {
    const work = assertVisible(
      await trx.selectFrom('app.work_items')
        .select(['id', 'code', 'description', 'unit_id', 'planned_qty'])
        .where('id', '=', input.workItemId).where('project_id', '=', projectId)
        .executeTakeFirst(),
      'Work item',
    );
    assertVisible(
      await trx.selectFrom('app.locations').select(['id', 'name'])
        .where('id', '=', input.locationId).where('project_id', '=', projectId)
        .executeTakeFirst(),
      'Location',
    );

    // ── Over-execution (FR-157 / VR-02) ────────────────────────────
    // Recording more than was planned is PERMITTED, flagged and reasoned.
    // Blocking it would mean the site simply stops recording — and a quantity
    // that was executed is a fact whether or not the plan expected it.
    const planned = await this.plannedFor(trx, input.workItemId, input.locationId, work.planned_qty);
    const already = await this.executedFor(trx, input.workItemId, input.locationId);
    const wouldTotal = already + Number(input.reportedQty);
    const isOver = planned > 0 && wouldTotal > planned + 0.0001;

    if (isOver && !input.overExecutionReason) {
      throw new BadRequestException(
        `That takes ${work.code} at this location to ${wouldTotal.toFixed(2)} of ` +
          `${planned.toFixed(2)} planned. Send over_execution_reason to record it anyway.`,
      );
    }

    const row = await trx.insertInto('app.progress_entries').values({
      org_id: actor.orgId,
      project_id: projectId,
      work_item_id: input.workItemId,
      location_id: input.locationId,
      reported_qty: input.reportedQty,
      unit_id: work.unit_id,
      executed_on: input.executedOn ?? new Date().toISOString().slice(0, 10),
      contractor_label: input.contractorLabel ?? null,
      note: input.note ?? null,
      reported_by: actor.userId,
      reported_by_grant_id: grantId ?? null,
      // FR-030: the record says "as Site Supervisor", not merely who typed it.
      reported_responsibility: responsibility ?? null,
      verification_status: 'reported',
      is_over_execution: isOver,
      over_execution_reason: isOver ? input.overExecutionReason! : null,
      client_uuid: input.clientUuid ?? null,
      is_offline_origin: !!input.clientUuid,
      device_clock_skew_ms: input.deviceClockSkewMs ?? null,
    }).returningAll().executeTakeFirstOrThrow();

    // Posted to the ledger as REPORTED. It does not count toward progress
    // until an engineer verifies it (BR-07) — the ledger records the claim,
    // the status decides whether it means anything.
    await this.postToLedger(trx, actor, row, 'reported');

    await this.audit.write(trx, actor.orgId, {
      entityType: 'progress_entry', entityId: row.id, action: 'create',
      projectId,
      changes: this.audit.diff(null, {
        work_item: work.code, location_id: input.locationId,
        reported_qty: row.reported_qty, executed_on: row.executed_on,
      }),
      context: {
        over_execution: isOver,
        planned, already_executed: already,
        offline: !!input.clientUuid,
      },
    });

    return {
      ...row,
      work_item_code: work.code,
      // Derived, never stored, never typed.
      progress_pct: planned > 0 ? Number(((wouldTotal / planned) * 100).toFixed(2)) : null,
      planned_qty: planned,
      cumulative_qty: wouldTotal,
    };
  }

  /**
   * Verification: accept, adjust with a reason, or reject with a reason.
   *
   * SoD-02 is enforced here, before the state machine: a user may never verify
   * a quantity they reported. On a small site one person often holds both
   * responsibilities, which is exactly why the refusal is about the ACT and not
   * about the role.
   */
  async verify(actor: ProgressActor, projectId: string, entryId: string, input: VerifyInput) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.progress.verify', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['field.progress.verify'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const before = assertVisible(
          await trx.selectFrom('app.progress_entries').selectAll()
            .where('id', '=', entryId).where('project_id', '=', projectId)
            .executeTakeFirst(),
          'Progress entry',
        );

        // SoD-02 — the claimant never verifies their own claim.
        this.sod.assertCanVerifyQuantity(
          { userId: actor.userId },
          { reportedBy: before.reported_by },
        );

        if (before.verification_status !== 'reported') {
          throw new ConflictException(
            `This entry was already ${before.verification_status}` +
              (before.verified_at ? ` on ${before.verified_at.toISOString().slice(0, 10)}` : '') +
              '. Raise an adjustment instead.',
          );
        }

        let status: 'verified' | 'adjusted' | 'rejected';
        let verifiedQty: string | null;

        switch (input.decision) {
          case 'accept':
            status = 'verified';
            verifiedQty = before.reported_qty;
            break;
          case 'adjust':
            if (!input.verifiedQty) {
              throw new BadRequestException('An adjustment needs the corrected quantity');
            }
            if (!input.reason || input.reason.trim().length < 3) {
              throw new BadRequestException(
                'An adjustment needs a reason. "Verified at 11 instead of 14" with no ' +
                  'reason is an argument waiting to happen.',
              );
            }
            status = 'adjusted';
            verifiedQty = input.verifiedQty;
            break;
          case 'reject':
            if (!input.reason || input.reason.trim().length < 3) {
              throw new BadRequestException('A rejection needs a reason the reporter can act on');
            }
            status = 'rejected';
            verifiedQty = '0';
            break;
        }

        const after = await trx.updateTable('app.progress_entries')
          .set({
            verification_status: status,
            // ★ reported_qty is NOT touched. The claim survives the adjustment.
            verified_qty: verifiedQty,
            verified_by: actor.userId,
            verified_by_grant_id: grant?.grantId ?? null,
            verified_responsibility: grant?.responsibilityLabel ?? null,
            verified_at: new Date(),
            verification_reason: input.reason ?? null,
          })
          .where('id', '=', entryId)
          .returningAll().executeTakeFirstOrThrow();

        // The ledger gets a second, typed posting rather than an edit: it is
        // append-only, so the claim and its verification both remain visible.
        await this.postToLedger(trx, actor, after, status === 'rejected' ? 'rejected' : 'verified');

        await this.audit.write(trx, actor.orgId, {
          entityType: 'progress_entry', entityId: entryId, action: 'verify',
          projectId,
          changes: [
            { field: 'verification_status', old: before.verification_status, new: status },
            { field: 'verified_qty', old: null, new: verifiedQty },
          ],
          context: {
            reported_qty: before.reported_qty,
            decision: input.decision,
            reason: input.reason ?? null,
            // The gap, recorded at the moment it is created.
            variance: verifiedQty
              ? Number(verifiedQty) - Number(before.reported_qty) : null,
          },
        });

        return after;
      },
    );
  }

  /**
   * FR-146 — the reported-vs-verified gap.
   *
   * This is a headline metric, not a diagnostic. A large or growing gap between
   * what is claimed and what is verified IS the signal; hiding it would defeat
   * the purpose of collecting both.
   */
  async verificationGap(actor: ProgressActor, projectId: string, from?: string, to?: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.progress.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const r = await sql<{
        reported_total: string; verified_total: string;
        entries: string; verified_entries: string; awaiting: string;
        adjusted: string; rejected: string; over_execution: string;
      }>`
        SELECT
          COALESCE(sum(reported_qty), 0)                                   AS reported_total,
          COALESCE(sum(verified_qty) FILTER (
            WHERE verification_status IN ('verified','adjusted')), 0)      AS verified_total,
          count(*)                                                         AS entries,
          count(*) FILTER (WHERE verification_status IN ('verified','adjusted')) AS verified_entries,
          count(*) FILTER (WHERE verification_status = 'reported')          AS awaiting,
          count(*) FILTER (WHERE verification_status = 'adjusted')          AS adjusted,
          count(*) FILTER (WHERE verification_status = 'rejected')          AS rejected,
          count(*) FILTER (WHERE is_over_execution)                         AS over_execution
        FROM app.progress_entries
        WHERE project_id = ${projectId}
          ${from ? sql`AND executed_on >= ${from}::date` : sql``}
          ${to ? sql`AND executed_on <= ${to}::date` : sql``}
      `.execute(trx);

      const row = r.rows[0]!;
      const reported = Number(row.reported_total);
      const verified = Number(row.verified_total);
      const gapPct = reported > 0 ? ((reported - verified) / reported) * 100 : 0;

      return {
        metric: 'reported_vs_verified_gap',
        value: Number(gapPct.toFixed(2)),
        unit: 'percent',
        as_of: new Date().toISOString(),
        definition:
          'Sum of reported quantity minus sum of verified quantity, over sum of ' +
          'reported quantity, for verified and adjusted entries. A widening gap ' +
          'means claims are outrunning verification.',
        breakdown: {
          reported_total: reported,
          verified_total: verified,
          variance: Number((verified - reported).toFixed(4)),
          entries: Number(row.entries),
          verified_entries: Number(row.verified_entries),
          awaiting_verification: Number(row.awaiting),
          adjusted: Number(row.adjusted),
          rejected: Number(row.rejected),
          over_execution: Number(row.over_execution),
        },
        // FR-521/522: every aggregate carries the query that reproduces it.
        drill: {
          endpoint: `/api/v1/projects/${projectId}/progress`,
          params: { status: 'adjusted' },
        },
      };
    });
  }

  /** Progress by work item x location, with the percentage DERIVED. */
  async summary(actor: ProgressActor, projectId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.progress.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const r = await sql<{
        work_item_id: string; code: string; description: string; unit_code: string;
        planned_qty: string; verified_qty: string; reported_qty: string; locations: string;
      }>`
        SELECT w.id AS work_item_id, w.code, w.description, u.code AS unit_code,
               w.planned_qty,
               COALESCE(sum(p.verified_qty) FILTER (
                 WHERE p.verification_status IN ('verified','adjusted')), 0) AS verified_qty,
               COALESCE(sum(p.reported_qty), 0) AS reported_qty,
               count(DISTINCT p.location_id)    AS locations
        FROM app.work_items w
        JOIN app.units u ON u.id = w.unit_id
        LEFT JOIN app.progress_entries p ON p.work_item_id = w.id
        WHERE w.project_id = ${projectId} AND w.is_active
        GROUP BY w.id, w.code, w.description, u.code, w.planned_qty
        ORDER BY w.code
      `.execute(trx);

      return r.rows.map((x) => {
        const planned = Number(x.planned_qty);
        const verified = Number(x.verified_qty);
        return {
          work_item_id: x.work_item_id,
          code: x.code,
          description: x.description,
          unit: x.unit_code,
          planned_qty: planned,
          verified_qty: verified,
          reported_qty: Number(x.reported_qty),
          locations_touched: Number(x.locations),
          // FR-142: derived here, never stored, never typed by a human.
          progress_pct: planned > 0 ? Number(((verified / planned) * 100).toFixed(2)) : null,
        };
      });
    });
  }

  async list(actor: ProgressActor, projectId: string, opts: {
    cursor?: string; limit: number; status?: string; locationId?: string;
    workItemId?: string; from?: string; to?: string; reportedBy?: string;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.progress.read', projectId)) {
      assertVisible(null, 'Project');
    }
    const qualifier = this.permissions.qualifierFor(actor.permissions, 'field.progress.read');

    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx.selectFrom('app.progress_entries as p')
        .innerJoin('app.work_items as w', 'w.id', 'p.work_item_id')
        .innerJoin('app.units as u', 'u.id', 'p.unit_id')
        .leftJoin('app.location_paths as lp', 'lp.location_id', 'p.location_id')
        .select(['p.id', 'p.reported_qty', 'p.verified_qty', 'p.verification_status',
                 'p.executed_on', 'p.reported_at', 'p.reported_by',
                 'p.reported_responsibility', 'p.verified_by', 'p.verified_responsibility',
                 'p.verification_reason', 'p.contractor_label', 'p.note',
                 'p.is_over_execution', 'p.daily_report_id',
                 'w.code as work_item_code', 'w.description as work_item',
                 'u.code as unit', 'lp.display_path as location'])
        .orderBy('p.id', 'desc')
        .limit(opts.limit + 1)
        .where('p.project_id', '=', projectId);

      // The record-level qualifier, applied as a predicate rather than a filter
      // in application code: a supervisor sees their own entries and nobody
      // else's, and the database is what enforces it.
      if (qualifier === 'own_created') qb = qb.where('p.reported_by', '=', actor.userId);

      if (opts.status) qb = qb.where('p.verification_status', '=', opts.status as 'reported');
      if (opts.locationId) qb = qb.where('p.location_id', '=', opts.locationId);
      if (opts.workItemId) qb = qb.where('p.work_item_id', '=', opts.workItemId);
      if (opts.reportedBy) qb = qb.where('p.reported_by', '=', opts.reportedBy);
      if (opts.from) qb = qb.where('p.executed_on', '>=', opts.from);
      if (opts.to) qb = qb.where('p.executed_on', '<=', opts.to);
      if (opts.cursor) qb = qb.where('p.id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return { data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore };
    });
  }

  // ── internals ────────────────────────────────────────────────────

  private async postToLedger(
    trx: Transaction<DB>, actor: ProgressActor,
    entry: { id: string; org_id: string; project_id: string; work_item_id: string;
             location_id: string; reported_qty: string; verified_qty: string | null;
             unit_id: string; executed_on: string; contractor_label: string | null;
             reported_by_grant_id: string | null },
    status: 'reported' | 'verified' | 'rejected',
  ): Promise<void> {
    await trx.insertInto('app.quantity_ledger').values({
      org_id: entry.org_id,
      project_id: entry.project_id,
      work_item_id: entry.work_item_id,
      location_id: entry.location_id,
      source_type: 'daily_report',
      source_id: entry.id,
      qty: status === 'reported' ? entry.reported_qty : (entry.verified_qty ?? '0'),
      unit_id: entry.unit_id,
      executed_on: entry.executed_on,
      contractor_label: entry.contractor_label,
      verification_status: status === 'reported' ? 'reported' : status,
      posted_by: actor.userId,
      posted_by_grant_id: entry.reported_by_grant_id,
    }).execute();
  }

  /** Planned quantity at this location, falling back to the line total when
   *  the work item has not been allocated per location. */
  private async plannedFor(
    trx: Transaction<DB>, workItemId: string, locationId: string, lineTotal: string,
  ): Promise<number> {
    const alloc = await trx.selectFrom('app.work_item_locations')
      .select('planned_qty')
      .where('work_item_id', '=', workItemId)
      .where('location_id', '=', locationId)
      .executeTakeFirst();
    if (alloc) return Number(alloc.planned_qty);

    const anyAlloc = await trx.selectFrom('app.work_item_locations')
      .select('id').where('work_item_id', '=', workItemId).executeTakeFirst();
    // If the item is allocated elsewhere but not here, there is no plan for
    // this location — so nothing to be over.
    return anyAlloc ? 0 : Number(lineTotal);
  }

  private async executedFor(
    trx: Transaction<DB>, workItemId: string, locationId: string,
  ): Promise<number> {
    const r = await sql<{ total: string }>`
      SELECT COALESCE(sum(reported_qty), 0) AS total
      FROM app.progress_entries
      WHERE work_item_id = ${workItemId} AND location_id = ${locationId}
        AND verification_status <> 'rejected'
    `.execute(trx);
    return Number(r.rows[0]!.total);
  }
}
