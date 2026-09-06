import { Body, Controller, Get, Param, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { ProgressService, type ProgressActor } from './progress.service.js';
import { DailyReportService } from './daily-report.service.js';
import {
  recordProgressSchema, verifySchema, listProgressSchema,
  dailyReportSchema, amendSchema, gapSchema, missingSchema, listReportsSchema,
} from './progress.dto.js';

const actorOf = (u: AuthenticatedUser): ProgressActor => ({
  userId: u.userId, orgId: u.orgId, permissions: u.permissions,
});

@Controller({ version: '1' })
export class ProgressController {
  constructor(
    private readonly progress: ProgressService,
    private readonly reports: DailyReportService,
  ) {}

  // ── Progress entries ────────────────────────────────────────────
  @Post('projects/:id/progress')
  @RequirePermission('field.progress.create')
  record(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(recordProgressSchema)) body: never,
  ) {
    return this.progress.record(actorOf(u), id, body);
  }

  @Get('projects/:id/progress')
  @RequirePermission('field.progress.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listProgressSchema)) q: never,
  ) {
    return this.progress.list(actorOf(u), id, q);
  }

  @Post('projects/:id/progress/:entryId/verify')
  @RequirePermission('field.progress.verify')
  verify(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body(new ZodValidationPipe(verifySchema)) body: never,
  ) {
    return this.progress.verify(actorOf(u), id, entryId, body);
  }

  @Get('projects/:id/progress/summary')
  @RequirePermission('field.progress.read')
  /**
   * FR-522: an aggregate states what it counts, when it was computed, and where
   * the rows behind it are. It returned a bare array until Phase 7 — a number
   * on a dashboard with no definition is a rumour with a font.
   */
  async summary(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return {
      metric: 'work_item_progress',
      as_of: new Date().toISOString(),
      definition:
        'Per work item: planned quantity, quantity reported by site, and ' +
        'quantity confirmed by a verifier. Percentages are derived from these ' +
        'three numbers and are never entered.',
      data: await this.progress.summary(actorOf(u), id),
      drill: { endpoint: `/api/v1/projects/${id}/progress`, params: {} },
    };
  }

  /** FR-146: the gap is a headline metric, with its definition and drill query. */
  @Get('projects/:id/progress/verification-gap')
  @RequirePermission('field.progress.read')
  gap(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(gapSchema)) q: { from?: string; to?: string },
  ) {
    return this.progress.verificationGap(actorOf(u), id, q.from, q.to);
  }

  // ── Daily report ────────────────────────────────────────────────
  @Get('projects/:id/daily-report')
  @RequirePermission('field.daily_report.read')
  today(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('date') date?: string,
  ) {
    return this.reports.today(actorOf(u), id, date);
  }

  /**
   * The office list, and one report in full.
   *
   * Plural, because `GET .../daily-report` singular answers "what is happening
   * on this date" — a different question, and the one the site surface asks.
   * S-W05 was written against the singular route and rendered an empty list
   * from a payload that was never a list.
   */
  @Get('projects/:id/daily-reports')
  @RequirePermission('field.daily_report.read')
  listReports(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listReportsSchema)) q: never,
  ) {
    return this.reports.list(actorOf(u), id, q as unknown as { limit: number });
  }

  @Get('projects/:id/daily-reports/:reportId')
  @RequirePermission('field.daily_report.read')
  oneReport(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.reports.one(actorOf(u), id, reportId);
  }

  @Post('projects/:id/daily-report')
  @RequirePermission('field.daily_report.create')
  upsert(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(dailyReportSchema)) body: never,
  ) {
    return this.reports.upsert(actorOf(u), id, body);
  }

  @Post('projects/:id/daily-report/:reportId/submit')
  @RequirePermission('field.daily_report.submit')
  submit(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.reports.submit(actorOf(u), id, reportId);
  }

  @Post('projects/:id/daily-report/:reportId/amend')
  @RequirePermission('field.daily_report.amend')
  amend(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body(new ZodValidationPipe(amendSchema)) body: { reason: string },
  ) {
    return this.reports.amend(actorOf(u), id, reportId, body.reason);
  }

  @Get('projects/:id/daily-report/missing')
  @RequirePermission('field.daily_report.read')
  missing(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(missingSchema)) q: { from: string; to: string },
  ) {
    return this.reports.missing(actorOf(u), id, q.from, q.to);
  }
}
