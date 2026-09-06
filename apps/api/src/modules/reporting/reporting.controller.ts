import {
  BadRequestException, Controller, Get, Header, Param, ParseUUIDPipe, Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { DashboardService } from './dashboard.service.js';
import { AuditQueryService } from './audit.query.service.js';
import { ReportsService, REPORT_KEYS, type ReportKey } from './reports.service.js';
import { DailyReportPdfService } from './daily-report.pdf.js';

const reportParamsSchema = z.object({
  projectId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
}).strict();

const auditQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  action: z.string().max(40).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

@Controller({ version: '1' })
export class ReportingController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly audit: AuditQueryService,
    private readonly reports: ReportsService,
    private readonly pdf: DailyReportPdfService,
  ) {}

  @Get('projects/:id/dashboard')
  @RequirePermission('report.dashboard.read')
  project(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.dashboard.project({ userId: u.userId, orgId: u.orgId }, id);
  }

  @Get('portfolio')
  @RequirePermission('report.dashboard.read')
  portfolio(@CurrentUser() u: AuthenticatedUser) {
    return this.dashboard.portfolio({ userId: u.userId, orgId: u.orgId });
  }

  /* ── The six reports (MVP_API_SCOPE §3) ──────────────────────── */

  @Get('reports')
  @RequirePermission('report.list.read')
  catalogue() {
    return { data: this.reports.catalogue() };
  }

  @Get('reports/:key')
  @RequirePermission('report.list.read')
  report(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key') key: string,
    @Query(new ZodValidationPipe(reportParamsSchema)) q: never,
  ) {
    assertReportKey(key);
    return this.reports.run({ userId: u.userId, orgId: u.orgId }, key, q as object);
  }

  /**
   * `.csv` on the same path, not a separate surface.
   *
   * One report definition, two renderings. A CSV produced by different code
   * from the screen is a CSV that eventually disagrees with it.
   */
  @Get('reports/:key.csv')
  @RequirePermission('report.export.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async reportCsv(
    @CurrentUser() u: AuthenticatedUser,
    @Param('key') key: string,
    @Query(new ZodValidationPipe(reportParamsSchema)) q: never,
  ) {
    const bare = key.replace(/\.csv$/, '');
    assertReportKey(bare);
    const report = await this.reports.run(
      { userId: u.userId, orgId: u.orgId }, bare, q as object);
    return this.reports.toCsv(report);
  }

  /**
   * The daily report as a printable document.
   *
   * `inline`, not `attachment`: it opens in a tab and Ctrl-P produces the PDF.
   * A site office prints and signs this, and a download that lands in a folder
   * is one step further from that.
   */
  @Get('projects/:id/daily-report/:reportId/print')
  @RequirePermission('report.pdf.generate', 'field.daily_report.read')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-disposition', 'inline')
  print(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.pdf.render({ userId: u.userId, orgId: u.orgId }, id, reportId);
  }

  @Get('audit')
  @RequirePermission('audit.log.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(auditQuerySchema)) q: never,
  ) {
    return this.audit.list({ userId: u.userId, orgId: u.orgId },
                           q as unknown as { limit: number });
  }

  /** The human-readable per-record history (FR-508). */
  @Get('audit/:entityType/:entityId')
  @RequirePermission('audit.log.read')
  timeline(
    @CurrentUser() u: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.audit.timeline({ userId: u.userId, orgId: u.orgId }, entityType, entityId);
  }

  @Get('audit.csv')
  @RequirePermission('audit.log.export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="audit.csv"')
  csv(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(auditQuerySchema)) q: never,
  ) {
    return this.audit.csv({ userId: u.userId, orgId: u.orgId },
                          q as unknown as { limit: number });
  }
}

function assertReportKey(key: string): asserts key is ReportKey {
  if (!(REPORT_KEYS as string[]).includes(key)) {
    throw new BadRequestException(
      `Unknown report '${key}'. The six are: ${REPORT_KEYS.join(', ')}.`,
    );
  }
}
