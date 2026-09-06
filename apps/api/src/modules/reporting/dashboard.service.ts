import { Injectable, Inject } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';

/**
 * The three-band dashboard (FR-525): what I need to know · what needs my
 * action · what is going wrong.
 *
 * `UI_UX_PLAN.md` §5.1 sketches this with budget, schedule, stock and advances.
 * None of those exist in the MVP — `MVP_SCOPE.md` §112 removes the schedule
 * tile outright ("nothing to compute it from") and the no-money boundary
 * removes the rest. Inventing tiles from data the product does not hold would
 * make the dashboard a mock-up, so this returns only what is measured.
 *
 * Every number carries `definition`, `as_of` and `drill` (FR-522). A number a
 * reader cannot trace to rows is a rumour with a font.
 */
export interface Actor { userId: string; orgId: string }

const nowIso = () => new Date().toISOString();

@Injectable()
export class DashboardService {
  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  async project(actor: Actor, projectId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const base = `/api/v1/projects/${projectId}`;

      const [progress, approvals, issues, reports, sync] = await Promise.all([
        sql<{
          planned: string; reported: string; verified: string;
          entries: string; awaiting: string;
        }>`
          SELECT
            COALESCE((SELECT sum(planned_qty) FROM app.work_items
                      WHERE project_id = ${projectId} AND is_active), 0) AS planned,
            COALESCE(sum(p.reported_qty), 0)                              AS reported,
            COALESCE(sum(p.verified_qty) FILTER (
              WHERE p.verification_status IN ('verified','adjusted')), 0) AS verified,
            count(p.id)                                                   AS entries,
            count(p.id) FILTER (WHERE p.verification_status = 'reported')  AS awaiting
          FROM app.progress_entries p WHERE p.project_id = ${projectId}
        `.execute(trx),

        sql<{ open: string; oldest_hours: string; overdue: string; mine: string }>`
          SELECT count(*)                                                     AS open,
                 COALESCE(max(extract(epoch FROM now() - t.assigned_at)/3600), 0) AS oldest_hours,
                 count(*) FILTER (WHERE t.sla_due_at < now())                 AS overdue,
                 count(*) FILTER (WHERE t.assignee_user_id = ${actor.userId}) AS mine
          FROM app.approval_tasks t
          WHERE t.project_id = ${projectId} AND t.status = 'pending'
        `.execute(trx),

        sql<{
          open: string; overdue: string; critical_open: string;
          reopened: string; mine: string; unanswered: string;
        }>`
          SELECT count(*) FILTER (WHERE i.state_class NOT IN ('closed','cancelled'))  AS open,
                 count(*) FILTER (WHERE i.state_class NOT IN ('closed','cancelled')
                                    AND i.due_date < current_date)                    AS overdue,
                 count(*) FILTER (WHERE i.state_class NOT IN ('closed','cancelled')
                                    AND i.severity IN ('high','critical'))            AS critical_open,
                 count(*) FILTER (WHERE i.reopen_count > 0)                           AS reopened,
                 count(*) FILTER (WHERE i.assignee_user_id = ${actor.userId}
                                    AND i.state_class NOT IN ('closed','cancelled'))  AS mine,
                 (SELECT count(*) FROM app.comments c
                   WHERE c.project_id = ${projectId} AND c.is_query
                     AND c.answered_at IS NULL)                                       AS unanswered
          FROM app.issues i WHERE i.project_id = ${projectId}
        `.execute(trx),

        sql<{ submitted: string; missing_days: string; last_date: string | null }>`
          WITH days AS (
            SELECT generate_series(current_date - 13, current_date, '1 day')::date AS d
          )
          SELECT
            (SELECT count(*) FROM app.daily_reports r
              WHERE r.project_id = ${projectId}
                AND r.report_date >= current_date - 13
                AND r.submitted_at IS NOT NULL)                              AS submitted,
            (SELECT count(*) FROM days
              WHERE NOT EXISTS (
                SELECT 1 FROM app.daily_reports r
                 WHERE r.project_id = ${projectId} AND r.report_date = days.d
                   AND r.submitted_at IS NOT NULL))                          AS missing_days,
            (SELECT max(report_date)::text FROM app.daily_reports r
              WHERE r.project_id = ${projectId} AND r.submitted_at IS NOT NULL) AS last_date
        `.execute(trx),

        sql<{ attention: string }>`
          SELECT count(*) AS attention FROM app.sync_operations
          WHERE status = 'rejected'
        `.execute(trx).catch(() => ({ rows: [{ attention: '0' }] })),
      ]);

      const p = progress.rows[0]!;
      const a = approvals.rows[0]!;
      const i = issues.rows[0]!;
      const r = reports.rows[0]!;

      const planned = Number(p.planned);
      const reported = Number(p.reported);
      const verified = Number(p.verified);
      const verifiedPct = planned > 0 ? (verified / planned) * 100 : 0;
      const reportedPct = planned > 0 ? (reported / planned) * 100 : 0;
      const gapPct = reported > 0 ? ((reported - verified) / reported) * 100 : 0;

      /* ── Band 3, assembled from the numbers above ────────────────
         Only conditions that are actually wrong appear. An empty "going
         wrong" band is the most useful thing this screen can say, and
         padding it with green tiles would destroy that. */
      const wrong: { key: string; severity: 'warn' | 'bad'; message: string;
                     drill?: { to: string } }[] = [];

      if (gapPct >= 25 && reported > 0) {
        wrong.push({
          key: 'verification_gap', severity: gapPct >= 50 ? 'bad' : 'warn',
          message: `${Math.round(gapPct)}% of reported quantity has not been verified` +
                   ` (${Number(p.awaiting)} entr${Number(p.awaiting) === 1 ? 'y' : 'ies'} waiting).`,
          drill: { to: '/office/progress?status=reported' },
        });
      }
      if (Number(r.missing_days) > 0) {
        wrong.push({
          key: 'missing_reports',
          severity: Number(r.missing_days) >= 3 ? 'bad' : 'warn',
          message: `${r.missing_days} of the last 14 site days have no submitted report.`,
          drill: { to: '/office/reports' },
        });
      }
      if (Number(i.overdue) > 0) {
        wrong.push({
          key: 'overdue_issues', severity: 'bad',
          message: `${i.overdue} issue${Number(i.overdue) === 1 ? ' is' : 's are'} past their due date.`,
          drill: { to: '/office/issues?overdue=true' },
        });
      }
      if (Number(a.overdue) > 0) {
        wrong.push({
          key: 'overdue_approvals', severity: 'bad',
          message: `${a.overdue} approval${Number(a.overdue) === 1 ? '' : 's'} past the agreed SLA` +
                   `, oldest waiting ${Math.round(Number(a.oldest_hours))} hours.`,
          drill: { to: '/office/approvals' },
        });
      }
      if (Number(i.reopened) > 0) {
        wrong.push({
          key: 'reopened_issues', severity: 'warn',
          message: `${i.reopened} issue${Number(i.reopened) === 1 ? ' has' : 's have'} been reopened` +
                   ' after being closed.',
          drill: { to: '/office/issues' },
        });
      }
      if (Number(i.unanswered) > 0) {
        wrong.push({
          key: 'unanswered_queries', severity: 'warn',
          message: `${i.unanswered} question${Number(i.unanswered) === 1 ? '' : 's'} unanswered` +
                   ' — each one is blocking something from closing.',
          drill: { to: '/office/issues' },
        });
      }

      return {
        as_of: nowIso(),
        know: [
          {
            key: 'verified_progress',
            value: Number(verifiedPct.toFixed(1)), unit: 'percent',
            secondary: `reported ${reportedPct.toFixed(1)}%`,
            definition:
              'Quantity confirmed by a verifier, over total planned quantity. ' +
              'Reported-but-unverified work is deliberately excluded — this is ' +
              'what is known to be done, not what has been claimed.',
            as_of: nowIso(),
            drill: { endpoint: `${base}/progress/summary`, params: {} },
          },
          {
            key: 'verification_gap',
            value: Number(gapPct.toFixed(1)), unit: 'percent',
            secondary: `${p.awaiting} awaiting a verifier`,
            definition:
              'Reported quantity minus verified quantity, over reported quantity. ' +
              'A widening gap means claims are outrunning verification.',
            as_of: nowIso(),
            drill: { endpoint: `${base}/progress/verification-gap`, params: {} },
          },
          {
            key: 'open_approvals',
            value: Number(a.open), unit: 'count',
            secondary: Number(a.open) > 0
              ? `oldest ${Math.round(Number(a.oldest_hours))}h` : 'nothing waiting',
            definition: 'Approval tasks on this project that nobody has decided yet.',
            as_of: nowIso(),
            drill: { endpoint: '/api/v1/me/approvals', params: {} },
          },
          {
            key: 'open_issues',
            value: Number(i.open), unit: 'count',
            secondary: `${i.critical_open} high or critical`,
            definition: 'Issues not yet closed or cancelled, at any severity.',
            as_of: nowIso(),
            drill: { endpoint: `${base}/issues`, params: { state: 'open' } },
          },
        ],
        act: {
          approvals_i_owe: Number(a.mine),
          issues_assigned_to_me: Number(i.mine),
          entries_awaiting_verification: Number(p.awaiting),
          definition:
            'Work addressed to you specifically. The full list is My Work; ' +
            'these are the counts behind it.',
          as_of: nowIso(),
          drill: { endpoint: '/api/v1/me/work', params: {} },
        },
        wrong,
        reports: {
          submitted_last_14_days: Number(r.submitted),
          missing_days: Number(r.missing_days),
          last_report_date: r.last_date,
        },
      };
    });
  }

  /**
   * The portfolio: the project dashboard's top band, one row per project.
   *
   * Computed in a single pass rather than by calling project() per project —
   * a management view over twenty sites should be one query, not twenty.
   */
  async portfolio(actor: Actor) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const rows = await sql<{
        id: string; code: string; name: string; state_class: string;
        planned: string; reported: string; verified: string; awaiting: string;
        open_issues: string; overdue_issues: string;
        open_approvals: string; oldest_approval_hours: string;
        last_report_date: string | null; missing_days: string;
      }>`
        SELECT pr.id, pr.code, pr.name, pr.state_class::text,
          COALESCE((SELECT sum(planned_qty) FROM app.work_items w
                     WHERE w.project_id = pr.id AND w.is_active), 0)            AS planned,
          COALESCE((SELECT sum(reported_qty) FROM app.progress_entries p
                     WHERE p.project_id = pr.id), 0)                            AS reported,
          COALESCE((SELECT sum(verified_qty) FROM app.progress_entries p
                     WHERE p.project_id = pr.id
                       AND p.verification_status IN ('verified','adjusted')), 0) AS verified,
          (SELECT count(*) FROM app.progress_entries p
            WHERE p.project_id = pr.id AND p.verification_status = 'reported')   AS awaiting,
          (SELECT count(*) FROM app.issues i
            WHERE i.project_id = pr.id
              AND i.state_class NOT IN ('closed','cancelled'))                  AS open_issues,
          (SELECT count(*) FROM app.issues i
            WHERE i.project_id = pr.id AND i.due_date < current_date
              AND i.state_class NOT IN ('closed','cancelled'))                  AS overdue_issues,
          (SELECT count(*) FROM app.approval_tasks t
            WHERE t.project_id = pr.id AND t.status = 'pending')                AS open_approvals,
          COALESCE((SELECT max(extract(epoch FROM now() - t.assigned_at)/3600)
                      FROM app.approval_tasks t
                     WHERE t.project_id = pr.id AND t.status = 'pending'), 0)   AS oldest_approval_hours,
          (SELECT max(report_date)::text FROM app.daily_reports r
            WHERE r.project_id = pr.id AND r.submitted_at IS NOT NULL)          AS last_report_date,
          (SELECT count(*) FROM generate_series(current_date - 6, current_date, '1 day') d
            WHERE NOT EXISTS (SELECT 1 FROM app.daily_reports r
                               WHERE r.project_id = pr.id AND r.report_date = d::date
                                 AND r.submitted_at IS NOT NULL))               AS missing_days
        FROM app.projects pr
        WHERE pr.state_class NOT IN ('closed','cancelled','void')
        ORDER BY pr.code
      `.execute(trx);

      return {
        metric: 'portfolio',
        as_of: nowIso(),
        definition:
          'One row per active project. Verified progress is confirmed quantity ' +
          'over planned; the gap is reported minus verified over reported. ' +
          'Missing reports count site days in the last 7 with nothing submitted.',
        drill: { endpoint: '/api/v1/projects', params: {} },
        data: rows.rows.map((r) => {
          const planned = Number(r.planned);
          const reported = Number(r.reported);
          const verified = Number(r.verified);
          return {
            id: r.id, code: r.code, name: r.name, state_class: r.state_class,
            verified_pct: planned > 0 ? Number(((verified / planned) * 100).toFixed(1)) : 0,
            reported_pct: planned > 0 ? Number(((reported / planned) * 100).toFixed(1)) : 0,
            gap_pct: reported > 0
              ? Number((((reported - verified) / reported) * 100).toFixed(1)) : 0,
            awaiting_verification: Number(r.awaiting),
            open_issues: Number(r.open_issues),
            overdue_issues: Number(r.overdue_issues),
            open_approvals: Number(r.open_approvals),
            oldest_approval_hours: Math.round(Number(r.oldest_approval_hours)),
            last_report_date: r.last_report_date,
            missing_report_days: Number(r.missing_days),
          };
        }),
      };
    });
  }
}
