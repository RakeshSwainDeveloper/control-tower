import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';
import { DailyReportService } from './daily-report.service.js';
import { ProgressSyncHandler } from './progress.sync-handler.js';
import { DailyReportSyncHandler } from './daily-report.sync-handler.js';

@Module({
  imports: [AccessModule, SyncModule, ApprovalModule],
  controllers: [ProgressController],
  // Both handlers register themselves into SyncRegistry on module init. The
  // sync engine gains two entities without a line of change.
  providers: [
    ProgressService, DailyReportService,
    ProgressSyncHandler, DailyReportSyncHandler,
  ],
  exports: [ProgressService, DailyReportService],
})
export class ProgressModule {}
