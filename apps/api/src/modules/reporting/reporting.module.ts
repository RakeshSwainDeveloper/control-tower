import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ReportingController } from './reporting.controller.js';
import { DashboardService } from './dashboard.service.js';
import { AuditQueryService } from './audit.query.service.js';
import { ReportsService } from './reports.service.js';
import { DailyReportPdfService } from './daily-report.pdf.js';

@Module({
  imports: [AccessModule],
  controllers: [ReportingController],
  providers: [DashboardService, AuditQueryService, ReportsService, DailyReportPdfService],
  exports: [DashboardService, AuditQueryService, ReportsService, DailyReportPdfService],
})
export class ReportingModule {}
