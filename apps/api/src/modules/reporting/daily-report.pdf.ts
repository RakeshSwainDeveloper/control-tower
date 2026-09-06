import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import type { Actor } from './dashboard.service.js';

/**
 * The daily report as a printable document (`MVP_SCOPE.md` §112).
 *
 * Rendered as self-contained HTML with a print stylesheet, not through a PDF
 * library. Two reasons, and the second is the one that matters:
 *
 *  · A headless-Chrome renderer is a second runtime, a second memory profile
 *    and a second thing to patch, for a document a site office prints and
 *    signs. The browser they already have does it.
 *  · The output stays readable and searchable. Somebody can open it, copy a
 *    quantity out of it, and see exactly what the screen showed — which is
 *    much harder to guarantee when a layout engine is in between.
 *
 * `Content-Disposition: inline` so it opens in a tab; Ctrl-P gives the PDF.
 * If a real binary PDF is ever required, this HTML is the input to it.
 */
@Injectable()
export class DailyReportPdfService {
  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  async render(actor: Actor, projectId: string, reportId: string): Promise<string> {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const report = await trx.selectFrom('app.daily_reports as r')
        .leftJoin('app.projects as p', 'p.id', 'r.project_id')
        .leftJoin('app.users as u', 'u.id', 'r.submitted_by')
        .select(['r.id', 'r.report_number', 'r.report_date', 'r.weather', 'r.notes',
                 'r.state_class', 'r.submitted_at',
                 'p.code as project_code', 'p.name as project_name',
                 'u.name as submitted_by_name'])
        .where('r.id', '=', reportId).where('r.project_id', '=', projectId)
        .executeTakeFirst();
      if (!report) throw new NotFoundException('Daily report not found');

      const entries = await sql<{
        work_item: string; work_item_code: string; location: string; unit: string;
        reported_qty: string; verified_qty: string | null;
        verification_status: string; verification_reason: string | null;
        reported_by_name: string | null; reported_responsibility: string | null;
        verified_by_name: string | null; verified_responsibility: string | null;
      }>`
        SELECT w.description AS work_item, w.code AS work_item_code,
               COALESCE(lp.display_path, '') AS location, u.code AS unit,
               p.reported_qty, p.verified_qty,
               p.verification_status::text, p.verification_reason,
               ru.name AS reported_by_name, p.reported_responsibility,
               vu.name AS verified_by_name, p.verified_responsibility
        FROM app.progress_entries p
        JOIN app.work_items w ON w.id = p.work_item_id
        JOIN app.units u ON u.id = p.unit_id
        LEFT JOIN app.location_paths lp ON lp.location_id = p.location_id
        LEFT JOIN app.users ru ON ru.id = p.reported_by
        LEFT JOIN app.users vu ON vu.id = p.verified_by
        WHERE p.daily_report_id = ${reportId}
        ORDER BY w.code, lp.display_path
      `.execute(trx);

      const decisions = await sql<{
        decision: string; comment: string | null; decided_at: Date;
        decided_by_name: string | null; responsibility_label: string | null;
      }>`
        SELECT d.decision::text, d.comment, d.decided_at,
               u.name AS decided_by_name, d.responsibility_label
        FROM app.approval_decisions d
        JOIN app.approval_instances i ON i.id = d.instance_id
        LEFT JOIN app.users u ON u.id = d.decided_by
        WHERE i.object_type = 'daily_report' AND i.object_id = ${reportId}
        ORDER BY d.decided_at
      `.execute(trx);

      const reported = entries.rows.reduce((n, e) => n + Number(e.reported_qty), 0);
      const verified = entries.rows.reduce((n, e) => n + Number(e.verified_qty ?? 0), 0);

      return page(report, entries.rows, decisions.rows, reported, verified);
    });
  }
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const num = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', {
  minimumFractionDigits: 0, maximumFractionDigits: 3,
});

function page(
  r: Record<string, unknown>,
  entries: Record<string, unknown>[],
  decisions: Record<string, unknown>[],
  reported: number, verified: number,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(r['report_number'] ?? 'Daily report')}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: #020617; margin: 0; font-variant-numeric: tabular-nums; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  .sub { color: #475569; font-size: 10pt; margin: 0 0 6mm; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-bottom: 6mm; }
  .cell { border: 1px solid #e2e8f0; border-radius: 2mm; padding: 3mm; }
  .cell b { display: block; font-size: 14pt; }
  .cell span { color: #475569; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em;
       color: #475569; border-bottom: 1px solid #cbd5e1; padding: 2mm 1.5mm; }
  td { border-bottom: 1px solid #eef2f6; padding: 2mm 1.5mm; vertical-align: top; }
  .n { text-align: right; }
  .muted { color: #475569; font-size: 9pt; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .06em;
       color: #475569; margin: 7mm 0 2mm; }
  /* Repeat the header on every printed page: a two-page report whose second
     page has no column headings is a report somebody misreads. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .sign { margin-top: 10mm; display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; }
  .sign div { border-top: 1px solid #94a3b8; padding-top: 2mm; font-size: 9pt; color: #475569; }
  .foot { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #e2e8f0;
          color: #475569; font-size: 8.5pt; }
</style></head><body>

<h1>Daily report — ${esc(r['project_name'])}</h1>
<p class="sub">
  ${esc(r['report_number'] ?? '')} ·
  ${new Date(String(r['report_date'])).toDateString()} ·
  ${esc(r['project_code'])} · status ${esc(r['state_class'])}
</p>

<div class="grid">
  <div class="cell"><b>${entries.length}</b><span>entries</span></div>
  <div class="cell"><b>${num(reported)}</b><span>reported</span></div>
  <div class="cell"><b>${num(verified)}</b><span>verified</span></div>
  <div class="cell"><b>${esc(r['weather'] ?? '—')}</b><span>weather</span></div>
</div>

<h2>Work recorded</h2>
<table>
  <thead><tr>
    <th>Work item</th><th>Location</th>
    <th class="n">Reported</th><th class="n">Verified</th><th>Recorded by</th>
  </tr></thead>
  <tbody>
    ${entries.map((e) => `<tr>
      <td>${esc(e['work_item'])}<div class="muted">${esc(e['work_item_code'])}</div></td>
      <td>${esc(e['location'])}</td>
      <td class="n">${num(e['reported_qty'])} ${esc(e['unit'])}</td>
      <td class="n">${e['verified_qty'] === null ? '—'
        : `${num(e['verified_qty'])} ${esc(e['unit'])}`}
        ${e['verification_reason']
          ? `<div class="muted">${esc(e['verification_reason'])}</div>` : ''}</td>
      <td>${esc(e['reported_by_name'])}
        <div class="muted">${e['reported_responsibility']
          ? `as ${esc(e['reported_responsibility'])}` : ''}</div></td>
    </tr>`).join('')}
    ${entries.length === 0 ? '<tr><td colspan="5" class="muted">No entries.</td></tr>' : ''}
  </tbody>
</table>

${r['notes'] ? `<h2>Notes</h2><p>${esc(r['notes'])}</p>` : ''}

${decisions.length ? `<h2>Approval</h2>
<table><tbody>
  ${decisions.map((d) => `<tr>
    <td>${esc(d['decision'])}</td>
    <td>${esc(d['decided_by_name'])}
      <div class="muted">${d['responsibility_label']
        ? `as ${esc(d['responsibility_label'])}` : ''}</div></td>
    <td class="muted">${new Date(String(d['decided_at'])).toLocaleString()}</td>
    <td>${esc(d['comment'] ?? '')}</td>
  </tr>`).join('')}
</tbody></table>` : ''}

<div class="sign">
  <div>Submitted by ${esc(r['submitted_by_name'] ?? '')}${r['submitted_at']
    ? ` · ${new Date(String(r['submitted_at'])).toLocaleString()}` : ''}</div>
  <div>Received on site</div>
</div>

<p class="foot">
  Generated ${new Date().toLocaleString()} from Control Tower.
  Quantities shown as <em>reported</em> are what site recorded; <em>verified</em>
  is what a second person confirmed. Where they differ, both are kept and the
  reason is printed beside them.
</p>
</body></html>`;
}
