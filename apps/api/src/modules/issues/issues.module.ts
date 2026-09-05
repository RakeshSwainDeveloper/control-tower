import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { ApprovalModule } from '../approval/approval.module.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';
import { ActionsService } from './actions.service.js';
import { IssuesSyncHandler } from './issues.sync-handler.js';

@Module({
  imports: [AccessModule, SyncModule, ApprovalModule],
  controllers: [IssuesController],
  providers: [IssuesService, ActionsService, IssuesSyncHandler],
  exports: [IssuesService, ActionsService],
})
export class IssuesModule {}
