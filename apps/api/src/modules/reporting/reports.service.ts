import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import type { Actor } from './dashboard.service.js';

/**
 * The six MVP reports (`MVP_API_SCOPE.md` §3).
 *
 * All run live, permission-scoped and CSV-exportable. No summary tables, no
 * async generation, no report builder — those are named as out of scope, and
 * each one is a system that has to be maintained long after the person who
 * asked for it has moved on.
 *
 * Every report returns the same envelope: `columns` describing what each
 * field is, `data`, and the FR-522 trio (`definition`, `as_of`, `drill`). One
 * shape means one CSV writer and one screen, rather than six of each.
 */
export type ReportKey =
  | 'daily-progress' | 'progress-summary' | 'verification-gap'
  | 'issue-ageing' | 'approval-ageing' | 'activity';

export interface ReportParams {
  projectId?: string;
  from?: string; to?: string;
  limit?: number;
}

export interface Column { key: string; header: string; numeric?: boolean }

export interface Report {
  report: ReportKey;
  title: string;
  as_of: string;
  definition: string;
  params: Record<string, unknown>;
  columns: Column[];
  data: Record<string, unknown>[];
  drill?: { endpoint: string; params: Record<string, unknown> };
}

const REPORTS: Record<ReportKey, { title: string; needsProject: boolean }> = {
  'daily-progress':   { title: 'Daily progress',        needsProject: true },
  'progress-summary': { title: 'Progress summary',      needsProject: true },
  'verification-gap': { title: 'Verification gap',      needsProject: true },
  'issue-ageing':     { title: 'Issue ageing',          needsProject: true },
  'approval-ageing':  { title: 'Approval ageing',       needsProject: false },
  activity:           { title: 'Activity',              needsProject: false },
};

export const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[];

/** Default window: the last 30 days. Long enough to be useful, short enough
 *  that nobody accidentally scans a year on a whim. */
const DEFAULT_DAYS = 30;

@Injectable()
export class ReportsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  catalogue() {
    return REPORT_KEYS.map((key) => ({
      key, title: REPORTS[key].title, requires_project: REPORTS[key].needsProject,
    }));
  }

  async run(actor: Actor, key: ReportKey, p: ReportParams): Promise<Report> {
    const meta = REPORTS[key];
    if (!meta) throw new BadRequestException(`Unknown report '${key}'`);
    if (meta.needsProject && !p.projectId) {
      throw new BadRequestException(
        `The ${meta.title} report is per project. Choose one first.`,
      );
    }

    const to = p.to ?? new Date().toISOString().slice(0, 10);
    const from = p.from
      ?? new Date(Date.now() - DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const limit = Math.min(p.limit ?? 1000, 5000);

    const common = {
      report: key, title: meta.title, as_of: new Date().toISOString(),
      params: { project_id: p.projectId ?? null, from, to },
    };

    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      switch (key) {
        case 'daily-progress': {
          const r = await sql<Record<string, unknown>>`
            SELECT p.executed_on::text                       AS date,
                   w.code                                    AS work_item_code,
                   w.description                             AS work_item,
                   u.code                                     AS unit,
                   lp.display_path                            AS location,
                   sum(p.reported_qty)                        AS reported,
                   sum(p.verified_qty) FILTER (
                     WHERE p.verification_status IN ('verified','adjusted')) AS verified,
                   count(*)                                   AS entries,
                   string_agg(DISTINCT ru.name, ', ')         AS reported_by
            FROM app.progress_entries p
            JOIN app.work_items w ON w.id = p.work_item_id
            JOIN app.units u ON u.id = p.unit_id
            LEFT JOIN app.location_paths lp ON lp.location_id = p.location_id
            LEFT JOIN app.users ru ON ru.id = p.reported_by
            WHERE p.project_id = ${p.projectId!}
              AND p.executed_on BETWEEN ${from}::date AND ${to}::date
            GROUP BY p.executed_on, w.code, w.description, u.code, lp.display_path
            ORDER BY p.executed_on DESC, w.code
            LIMIT ${limit}
          `.execute(trx);
          return {
            ...common,
            definition:
              'Every quantity recorded on each date, grouped by work item and ' +
              'location, with what a verifier has since confirmed.',
            columns: [
              { key: 'date', header: 'Date' },
              { key: 'work_item_code', header: 'Code' },
              { key: 'work_item', header: 'Work item' },
              { key: 'location', header: 'Location' },
              { key: 'unit', header: 'Unit' },
              { key: 'reported', header: 'Reported', numeric: true },
              { key: 'verified', header: 'Verified', numeric: true },
              { key: 'entries', header: 'Entries', numeric: true },
              { key: 'reported_by', header: 'Recorded by' },
            ],
            data: r.rows,
            drill: { endpoint: `/api/v1/projects/${p.projectId}/progress`, params: {} },
          };
        }

        case 'progress-summary': {
          const r = await sql<Record<string, unknown>>`
            SELECT w.code, w.description AS work_item, u.code AS unit,
                   w.planned_qty                              AS planned,
                   COALESCE(sum(p.reported_qty), 0)           AS reported,
                   COALESCE(sum(p.verified_qty) FILTER (
                     WHERE p.verification_status IN ('verified','adjusted')), 0) AS verified,
                   count(DISTINCT p.location_id)              AS locations,
                   CASE WHEN w.planned_qty > 0
                        THEN round(100 * COALESCE(sum(p.verified_qty) FILTER (
                               WHERE p.verification_status IN ('verified','adjusted')), 0)
                             / w.planned_qty, 1)
                        ELSE 0 END                            AS verified_pct
            FROM app.work_items w
            JOIN app.units u ON u.id = w.unit_id
            LEFT JOIN app.progress_entries p ON p.work_item_id = w.id
            WHERE w.project_id = ${p.projectId!} AND w.is_active
            GROUP BY w.id, w.code, w.description, u.code, w.planned_qty
            ORDER BY w.code
          `.execute(trx);
          return {
            ...common,
            definition:
              'Per work item: planned quantity, what site has claimed, and what ' +
              'a verifier has confirmed. The percentage is derived from those ' +
              'three numbers and is never entered by anyone.',
            columns: [
              { key: 'code', header: 'Code' },
              { key: 'work_item', header: 'Work item' },
              { key: 'unit', header: 'Unit' },
              { key: 'planned', header: 'Planned', numeric: true },
              { key: 'reported', header: 'Reported', numeric: true },
              { key: 'verified', header: 'Verified', numeric: true },
              { key: 'verified_pct', header: 'Verified %', numeric: true },
              { key: 'locations', header: 'Locations', numeric: true },
            ],
            data: r.rows,
            drill: { endpoint: `/api/v1/projects/${p.projectId}/progress`, params: {} },
          };
        }

        case 'verification-gap': {
          /* By period AND by reporter, as specified. Naming the reporter is
             the point: a gap concentrated on one person is a conversation,
             a gap spread evenly is a staffing problem. */
          const r = await sql<Record<string, unknown>>`
            SELECT to_char(date_trunc('week', p.executed_on), 'YYYY-MM-DD') AS week,
                   ru.name                                     AS reported_by,
                   COALESCE(rg.responsibility_label, '')       AS responsibility,
                   count(*)                                    AS entries,
                   sum(p.reported_qty)                         AS reported,
                   COALESCE(sum(p.verified_qty), 0)            AS verified,
                   count(*) FILTER (WHERE p.verification_status = 'reported')  AS awaiting,
                   count(*) FILTER (WHERE p.verification_status = 'adjusted')  AS adjusted,
                   count(*) FILTER (WHERE p.verification_status = 'rejected')  AS rejected,
                   CASE WHEN sum(p.reported_qty) > 0
                        THEN round(100 * (sum(p.reported_qty) - COALESCE(sum(p.verified_qty), 0))
                                   / sum(p.reported_qty), 1)
                        ELSE 0 END                             AS gap_pct
            FROM app.progress_entries p
            LEFT JOIN app.users ru ON ru.id = p.reported_by
            LEFT JOIN app.role_grants rg ON rg.id = p.reported_by_grant_id
            WHERE p.project_id = ${p.projectId!}
              AND p.executed_on BETWEEN ${from}::date AND ${to}::date
            GROUP BY 1, 2, 3
            ORDER BY 1 DESC, 2
            LIMIT ${limit}
          `.execute(trx);
          return {
            ...common,
            definition:
              'Reported minus verified quantity, over reported, by week and by ' +
              'the person who recorded it. A gap concentrated on one reporter is ' +
              'a different problem from one spread across everybody.',
            columns: [
              { key: 'week', header: 'Week' },
              { key: 'reported_by', header: 'Recorded by' },
              { key: 'responsibility', header: 'As' },
              { key: 'entries', header: 'Entries', numeric: true },
              { key: 'reported', header: 'Reported', numeric: true },
              { key: 'verified', header: 'Verified', numeric: true },
              { key: 'gap_pct', header: 'Gap %', numeric: true },
              { key: 'awaiting', header: 'Awaiting', numeric: true },
              { key: 'adjusted', header: 'Adjusted', numeric: true },
              { key: 'rejected', header: 'Rejected', numeric: true },
            ],
            data: r.rows,
            drill: {
              endpoint: `/api/v1/projects/${p.projectId}/progress`,
              params: { status: 'reported' },
            },
          };
        }

        case 'issue-ageing': {
          const r = await sql<Record<string, unknown>>`
            SELECT i.issue_number, i.title, i.severity::text,
                   i.state_class::text                        AS status,
                   COALESCE(c.name, '')                       AS category,
                   COALESCE(lp.display_path, '')              AS location,
                   COALESCE(au.name, '')                      AS assignee,
                   i.due_date::text,
                   round(extract(epoch FROM now() - i.raised_at)/86400)::int AS age_days,
                   (i.due_date IS NOT NULL AND i.due_date < current_date)    AS overdue,
                   i.reopen_count
            FROM app.issues i
            LEFT JOIN app.master_data c ON c.id = i.category_id
            LEFT JOIN app.location_paths lp ON lp.location_id = i.location_id
            LEFT JOIN app.users au ON au.id = i.assignee_user_id
            WHERE i.project_id = ${p.projectId!}
              AND i.state_class NOT IN ('closed','cancelled')
            ORDER BY
              CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                              WHEN 'medium' THEN 2 ELSE 3 END,
              i.raised_at
            LIMIT ${limit}
          `.execute(trx);
          return {
            ...common,
            definition:
              'Open issues, most severe and oldest first, with how many days ' +
              'each has been open and who owns it.',
            columns: [
              { key: 'issue_number', header: 'No.' },
              { key: 'title', header: 'Issue' },
              { key: 'severity', header: 'Severity' },
              { key: 'status', header: 'Status' },
              { key: 'category', header: 'Category' },
              { key: 'location', header: 'Location' },
              { key: 'assignee', header: 'Assigned to' },
              { key: 'age_days', header: 'Age (days)', numeric: true },
              { key: 'due_date', header: 'Due' },
              { key: 'overdue', header: 'Overdue' },
              { key: 'reopen_count', header: 'Reopened', numeric: true },
            ],
            data: r.rows,
            drill: { endpoint: `/api/v1/projects/${p.projectId}/issues`, params: {} },
          };
        }

        case 'approval-ageing': {
          /* By approver and age band, as specified. The bands are what make
             this actionable: "6 pending" is a number, "3 of them over a week
             old, all with the same person" is a conversation. */
          const r = await sql<Record<string, unknown>>`
            SELECT COALESCE(au.name, 'unassigned')            AS approver,
                   i.object_type,
                   COALESCE(pr.code, '')                      AS project,
                   count(*)                                   AS pending,
                   count(*) FILTER (WHERE t.assigned_at > now() - interval '1 day')  AS under_1d,
                   count(*) FILTER (WHERE t.assigned_at <= now() - interval '1 day'
                                      AND t.assigned_at > now() - interval '3 days') AS d1_3,
                   count(*) FILTER (WHERE t.assigned_at <= now() - interval '3 days'
                                      AND t.assigned_at > now() - interval '7 days') AS d3_7,
                   count(*) FILTER (WHERE t.assigned_at <= now() - interval '7 days') AS over_7d,
                   count(*) FILTER (WHERE t.sla_due_at < now())                      AS past_sla,
                   round(max(extract(epoch FROM now() - t.assigned_at)/3600))::int   AS oldest_hours
            FROM app.approval_tasks t
            JOIN app.approval_instances i ON i.id = t.instance_id
            LEFT JOIN app.users au ON au.id = t.assignee_user_id
            LEFT JOIN app.projects pr ON pr.id = t.project_id
            WHERE t.status = 'pending'
              AND (${p.projectId ?? null}::uuid IS NULL
                   OR t.project_id = ${p.projectId ?? null}::uuid)
            GROUP BY 1, 2, 3
            ORDER BY over_7d DESC, pending DESC
            LIMIT ${limit}
          `.execute(trx);
          return {
            ...common,
            definition:
              'Approvals nobody has decided, by approver and how long they have ' +
              'waited. The bands matter more than the total: three items over a ' +
              'week old with one person is a different problem from six spread ' +
              'across the team.',
            columns: [
              { key: 'approver', header: 'Waiting on' },
              { key: 'object_type', header: 'Type' },
              { key: 'project', header: 'Project' },
              { key: 'pending', header: 'Pending', numeric: true },
              { key: 'under_1d', header: '< 1 day', numeric: true },
              { key: 'd1_3', header: '1–3 days', numeric: true },
              { key: 'd3_7', header: '3–7 days', numeric: true },
              { key: 'over_7d', header: '> 7 days', numeric: true },
              { key: 'past_sla', header: 'Past SLA', numeric: true },
              { key: 'oldest_hours', header: 'Oldest (h)', numeric: true },
            ],
            data: r.rows,
            drill: { endpoint: '/api/v1/me/approvals', params: {} },
          };
        }

        case 'activity': {
          /* "Who did what, when, as which responsibility" — the report that
             answers J9, and the reason FR-030 exists. */
          const r = await sql<Record<string, unknown>>`
            SELECT to_char(a.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS occurred_at,
                   COALESCE(u.name, 'system')                 AS actor,
                   COALESCE(a.responsibility_label, '')       AS responsibility,
                   a.action::text,
                   a.entity_type,
                   a.entity_id::text,
                   COALESCE(pr.code, '')                      AS project,
                   a.source::text
            FROM app.audit_log a
            LEFT JOIN app.users u ON u.id = a.actor_user_id
            LEFT JOIN app.projects pr ON pr.id = a.project_id
            WHERE a.occurred_at >= ${from}::date
              AND a.occurred_at < (${to}::date + 1)
              AND (${p.projectId ?? null}::uuid IS NULL
                   OR a.project_id = ${p.projectId ?? null}::uuid)
            ORDER BY a.occurred_at DESC
            LIMIT ${limit}
          `.execute(trx);
          return {
            ...common,
            definition:
              'Who did what, when, and in what capacity. This is the record an ' +
              'auditor reads: the responsibility column is the answer to "who ' +
              'said this was done".',
            columns: [
              { key: 'occurred_at', header: 'When' },
              { key: 'actor', header: 'Who' },
              { key: 'responsibility', header: 'As' },
              { key: 'action', header: 'Did' },
              { key: 'entity_type', header: 'To' },
              { key: 'project', header: 'Project' },
              { key: 'source', header: 'Via' },
            ],
            data: r.rows,
            drill: { endpoint: '/api/v1/audit', params: {} },
          };
        }
      }
    });
  }

  /** One CSV writer for all six, because they all return the same shape. */
  toCsv(report: Report): string {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [report.columns.map((c) => esc(c.header)).join(',')];
    for (const row of report.data) {
      lines.push(report.columns.map((c) => esc(row[c.key])).join(','));
    }
    // The definition travels with the export. A CSV in somebody's inbox six
    // months from now should still say what it counted and when.
    lines.push('');
    lines.push(esc(`${report.title} — ${report.definition}`));
    lines.push(esc(`Generated ${report.as_of}; parameters ${JSON.stringify(report.params)}`));
    return lines.join('\n');
  }
}
