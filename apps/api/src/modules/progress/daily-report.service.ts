import {
  Injectable, Inject, BadRequestException, ConflictException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { ApprovalEngine } from '../approval/approval.engine.js';
import { PermissionService } from '../access/permission.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { ProgressActor } from './progress.service.js';

@Injectable()
export class DailyReportService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly approval: ApprovalEngine,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The day's review screen, not a form.
   *
   * Everything here is already captured: the entries came in through the day,
   * at the locations, with their photographs. What is left is weather, optional
   * manpower and a note — which is why the target is 60 seconds and not the
   * two-to-three minutes a five-step wizard costs.
   */
  async today(actor: ProgressActor, projectId: string, date?: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.read', projectId)) {
      assertVisible(null, 'Project');
    }
    const day = date ?? new Date().toISOString().slice(0, 10);

    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const report = await trx.selectFrom('app.daily_reports').selectAll()
        .where('project_id', '=', projectId).where('report_date', '=', day)
        .where('amends_report_id', 'is', null)
        .executeTakeFirst();

      const entries = await trx.selectFrom('app.progress_entries as p')
        .innerJoin('app.work_items as w', 'w.id', 'p.work_item_id')
        .innerJoin('app.units as u', 'u.id', 'p.unit_id')
        .leftJoin('app.location_paths as lp', 'lp.location_id', 'p.location_id')
        .select(['p.id', 'p.reported_qty', 'p.verified_qty', 'p.verification_status',
                 'p.verification_reason', 'p.contractor_label', 'p.reported_at',
                 'p.reported_responsibility', 'p.is_over_execution',
                 'w.code as work_item_code', 'w.description as work_item',
                 'u.code as unit', 'lp.display_path as location'])
        .where('p.project_id', '=', projectId).where('p.executed_on', '=', day)
        .orderBy('p.reported_at')
        .execute();

      const evidenceCount = await sql<{ n: string }>`
        SELECT count(*) AS n FROM app.evidence_links l
        WHERE l.entity_type = 'progress_entry'
          AND l.unlinked_at IS NULL
          AND l.entity_id IN (
            SELECT id FROM app.progress_entries
            WHERE project_id = ${projectId} AND executed_on = ${day}
          )
      `.execute(trx);

      // FR-141: pre-filled from yesterday. The supervisor edits rather than
      // typing from blank — a blank form at 8pm is a form that does not get
      // filled.
      const yesterday = await trx.selectFrom('app.daily_reports')
        .select(['weather', 'manpower', 'work_start', 'work_stop'])
        .where('project_id', '=', projectId).where('report_date', '<', day)
        .orderBy('report_date', 'desc').executeTakeFirst();

      return {
        date: day,
        report: report ?? null,
        locked: !!report?.locked_at,
        entries,
        counts: {
          entries: entries.length,
          verified: entries.filter((e) => e.verification_status === 'verified').length,
          adjusted: entries.filter((e) => e.verification_status === 'adjusted').length,
          awaiting: entries.filter((e) => e.verification_status === 'reported').length,
          evidence: Number(evidenceCount.rows[0]!.n),
        },
        prefill: report ? null : {
          weather: yesterday?.weather ?? null,
          manpower: yesterday?.manpower ?? [],
          work_start: yesterday?.work_start ?? null,
          work_stop: yesterday?.work_stop ?? null,
        },
      };
    });
  }

  async upsert(actor: ProgressActor, projectId: string, input: {
    reportDate?: string; weather?: string; workStart?: string; workStop?: string;
    manpower?: Array<{ trade: string; contractor?: string; count: number }>;
    notes?: string; clientUuid?: string;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.create', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['field.daily_report.create'];
    const day = input.reportDate ?? new Date().toISOString().slice(0, 10);

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      (trx) => this.upsertInTrx(trx, actor, projectId, day, input, grant?.grantId, grant?.responsibilityLabel),
    );
  }

  /** Shared with the sync handler, so offline and online produce the same row. */
  async upsertInTrx(
    trx: Transaction<DB>, actor: ProgressActor, projectId: string, day: string,
    input: {
      weather?: string; workStart?: string; workStop?: string;
      manpower?: Array<{ trade: string; contractor?: string; count: number }>;
      notes?: string; clientUuid?: string;
    },
    grantId?: string, responsibility?: string,
  ) {
    const existing = await trx.selectFrom('app.daily_reports').selectAll()
      .where('project_id', '=', projectId).where('report_date', '=', day)
      .where('amends_report_id', 'is', null).where('merged_from_report_id', 'is', null)
      .executeTakeFirst();

    if (existing?.locked_at) {
      throw new ConflictException(
        `The report for ${day} is submitted and locked. Raise an amendment instead.`,
      );
    }

    const values = {
      weather: input.weather ?? null,
      work_start: input.workStart ?? null,
      work_stop: input.workStop ?? null,
      manpower: JSON.stringify(input.manpower ?? []),
      notes: input.notes ?? null,
      updated_by: actor.userId,
    };

    if (existing) {
      const after = await trx.updateTable('app.daily_reports').set(values)
        .where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
      await this.audit.write(trx, actor.orgId, {
        entityType: 'daily_report', entityId: after.id, action: 'update',
        projectId, changes: this.audit.diff(existing, after),
      });
      return after;
    }

    const row = await trx.insertInto('app.daily_reports').values({
      org_id: actor.orgId, project_id: projectId, report_date: day,
      ...values,
      state_class: 'draft',
      created_by: actor.userId,
      created_by_grant_id: grantId ?? null,
      client_uuid: input.clientUuid ?? null,
    }).returningAll().executeTakeFirstOrThrow();

    await this.audit.write(trx, actor.orgId, {
      entityType: 'daily_report', entityId: row.id, action: 'create',
      projectId, changes: this.audit.diff(null, { report_date: day }),
      responsibilityLabel: responsibility ?? null,
    });
    return row;
  }

  /**
   * Submit the day.
   *
   * This is the moment the day's entries LOCK (FR-144). Corrections after this
   * are amendments that stand alongside the original, never edits — because a
   * record that can be quietly rewritten after the fact is not evidence of
   * anything.
   */
  /**
   * The list, and one report in full.
   *
   * `today()` answers "what is happening on this date" and is what the site
   * surface needs. The office needs the other two questions — "what have we
   * had" and "show me that one" — and had no endpoint for either, so S-W05
   * rendered an empty list against a payload that was never a list.
   */
  async list(actor: ProgressActor, projectId: string, opts: {
    cursor?: string; limit: number; from?: string; to?: string;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx.selectFrom('app.daily_reports as r')
        .leftJoin('app.users as u', 'u.id', 'r.submitted_by')
        .select(['r.id', 'r.report_number', 'r.report_date', 'r.state_class',
                 'r.weather', 'r.notes', 'r.submitted_at',
                 'u.name as submitted_by_name',
                 (eb) => eb.selectFrom('app.progress_entries as p')
                   .select((e) => e.fn.countAll<number>().as('n'))
                   .whereRef('p.daily_report_id', '=', 'r.id').as('entry_count')])
        .where('r.project_id', '=', projectId)
        .orderBy('r.report_date', 'desc')
        .limit(opts.limit + 1);

      if (opts.from) qb = qb.where('r.report_date', '>=', opts.from);
      if (opts.to) qb = qb.where('r.report_date', '<=', opts.to);
      if (opts.cursor) qb = qb.where('r.report_date', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data,
        next_cursor: hasMore ? String(data[data.length - 1]!.report_date).slice(0, 10) : null,
        has_more: hasMore,
      };
    });
  }

  async one(actor: ProgressActor, projectId: string, reportId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const report = assertVisible(
        await trx.selectFrom('app.daily_reports as r')
          .leftJoin('app.users as u', 'u.id', 'r.submitted_by')
          .select(['r.id', 'r.report_number', 'r.report_date', 'r.state_class',
                   'r.weather', 'r.notes', 'r.submitted_at',
                   'u.name as submitted_by_name'])
          .where('r.id', '=', reportId).where('r.project_id', '=', projectId)
          .executeTakeFirst(),
        'Daily report',
      );
      const entries = await trx.selectFrom('app.progress_entries as p')
        .innerJoin('app.work_items as w', 'w.id', 'p.work_item_id')
        .innerJoin('app.units as u', 'u.id', 'p.unit_id')
        .leftJoin('app.location_paths as lp', 'lp.location_id', 'p.location_id')
        .leftJoin('app.users as ru', 'ru.id', 'p.reported_by')
        .select(['p.id', 'p.reported_qty', 'p.verified_qty', 'p.verification_status',
                 'p.verification_reason', 'w.description as work_item',
                 'u.code as unit', 'lp.display_path as location',
                 'ru.name as reported_by_name', 'p.reported_responsibility'])
        .where('p.daily_report_id', '=', reportId)
        .orderBy('p.id')
        .execute();
      return { report, entries };
    });
  }

  async submit(actor: ProgressActor, projectId: string, reportId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.submit', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['field.daily_report.submit'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const report = assertVisible(
          await trx.selectFrom('app.daily_reports').selectAll()
            .where('id', '=', reportId).where('project_id', '=', projectId)
            .forUpdate().executeTakeFirst(),
          'Daily report',
        );
        if (report.locked_at) {
          throw new ConflictException('That report has already been submitted');
        }

        const entries = await trx.selectFrom('app.progress_entries')
          .select(['id']).where('project_id', '=', projectId)
          .where('executed_on', '=', report.report_date)
          .where('daily_report_id', 'is', null)
          .execute();

        if (entries.length === 0) {
          throw new BadRequestException(
            'There is nothing to submit for that day. Record the work first.',
          );
        }

        // Attach the day's entries, THEN lock. Order matters: locking first
        // would trip the lock guard on the very rows being attached.
        await trx.updateTable('app.progress_entries')
          .set({ daily_report_id: reportId })
          .where('project_id', '=', projectId)
          .where('executed_on', '=', report.report_date)
          .where('daily_report_id', 'is', null)
          .execute();

        const number = (await sql<{ n: string }>`
          SELECT app.next_document_number('daily_report',
            (SELECT code FROM app.projects WHERE id = ${projectId})) AS n
        `.execute(trx)).rows[0]!.n;

        const after = await trx.updateTable('app.daily_reports').set({
          state_class: 'submitted',
          report_number: number,
          submitted_at: new Date(),
          submitted_by: actor.userId,
          submitted_by_grant_id: grant?.grantId ?? null,
          locked_at: new Date(),
        }).where('id', '=', reportId).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: 'daily_report', entityId: reportId, action: 'transition',
          projectId,
          changes: [{ field: 'state_class', old: report.state_class, new: 'submitted' }],
          context: { report_number: number, entries_locked: entries.length },
          responsibilityLabel: grant?.responsibilityLabel ?? null,
        });

        /**
         * Hand it to the approval engine.
         *
         * Wired in Phase 7. Phase 6 wired issue closure and missed this one,
         * which made the whole approval half of the product unreachable: the
         * daily report is the object an approver actually sees, once per site
         * per day, and without this call the inbox was empty for ever.
         *
         * `submitted` is where this service stops. Only the engine sets an
         * approved state class (BR-21), and if no workflow is configured it
         * refuses loudly rather than auto-approving (BR-22) — so a tenant that
         * has not configured one is told, and the report simply stays
         * submitted rather than silently becoming approved.
         */
        let approval: { required: boolean; instance_id?: string; reason?: string };
        try {
          const instance = await this.approval.submitInTrx(
            trx,
            {
              userId: actor.userId, orgId: actor.orgId,
              grantId: grant?.grantId, responsibility: grant?.responsibilityLabel,
            },
            {
              objectType: 'daily_report', objectId: reportId, projectId,
              // SoD-01 is evaluated against the SUBMITTER: a supervisor must
              // not end up approving their own day.
              createdBy: actor.userId,
              context: { report_number: number, entries: entries.length,
                         report_date: report.report_date },
            },
          );
          approval = { required: true, instance_id: instance.id };
        } catch (e) {
          // A tenant with no workflow configured is a configuration gap, not a
          // failed submission. The day's work is recorded and locked either
          // way; refusing the whole submission would punish the supervisor for
          // something only a company admin can fix.
          if (e instanceof BadRequestException) {
            approval = { required: false, reason: (e as Error).message };
          } else {
            throw e;
          }
        }

        return { ...after, entries_locked: entries.length, approval };
      },
    );
  }

  /**
   * An amendment (FR-144 / BR-10).
   *
   * The original is never touched. The amendment carries its reason and both
   * appear on the record's timeline in sequence, so a reader can see what was
   * first claimed and what was later corrected.
   */
  async amend(actor: ProgressActor, projectId: string, reportId: string, reason: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.amend', projectId)) {
      assertVisible(null, 'Project');
    }
    if (reason.trim().length < 5) {
      throw new BadRequestException('An amendment needs a reason a reader can understand');
    }
    const grant = actor.permissions.keys['field.daily_report.amend'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const original = assertVisible(
          await trx.selectFrom('app.daily_reports').selectAll()
            .where('id', '=', reportId).where('project_id', '=', projectId)
            .executeTakeFirst(),
          'Daily report',
        );
        if (!original.locked_at) {
          throw new BadRequestException(
            'That report is still open — edit it rather than amending it.',
          );
        }

        const amendment = await trx.insertInto('app.daily_reports').values({
          org_id: actor.orgId, project_id: projectId,
          report_date: original.report_date,
          weather: original.weather, work_start: original.work_start,
          work_stop: original.work_stop, manpower: JSON.stringify(original.manpower),
          notes: original.notes,
          state_class: 'draft',
          amends_report_id: reportId,
          amendment_reason: reason,
          created_by: actor.userId,
          created_by_grant_id: grant?.grantId ?? null,
        }).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: 'daily_report', entityId: amendment.id, action: 'create',
          projectId,
          context: { amends: reportId, reason, report_date: original.report_date },
          responsibilityLabel: grant?.responsibilityLabel ?? null,
        });
        return amendment;
      },
    );
  }

  /**
   * FR-148 — days with no report.
   *
   * Not a nag: a missing day is counted, and it is one of the integrity signals
   * the weekly report surfaces. The system exposes problems rather than hiding
   * them (P-12).
   */
  async missing(actor: ProgressActor, projectId: string, from: string, to: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'field.daily_report.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const r = await sql<{ day: string; has_entries: boolean }>`
        SELECT d::date::text AS day,
               EXISTS (SELECT 1 FROM app.progress_entries p
                       WHERE p.project_id = ${projectId} AND p.executed_on = d::date) AS has_entries
        FROM generate_series(${from}::date, ${to}::date, '1 day') d
        WHERE NOT EXISTS (
          SELECT 1 FROM app.daily_reports r
          WHERE r.project_id = ${projectId} AND r.report_date = d::date
            AND r.submitted_at IS NOT NULL
        )
        ORDER BY d
      `.execute(trx);
      return {
        from, to,
        missing_days: r.rows.length,
        // A day with entries but no submission is a different problem from a
        // day with nothing at all, and they need different follow-up.
        days: r.rows.map((x) => ({
          date: x.day,
          had_unreported_work: x.has_entries,
        })),
      };
    });
  }
}
