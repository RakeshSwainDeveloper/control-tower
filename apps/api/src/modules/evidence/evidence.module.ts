import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';
import { StorageService } from './storage.service.js';
import { EvidenceLinkSyncHandler } from './evidence.sync-handler.js';

@Module({
  imports: [AccessModule, SyncModule],
  controllers: [EvidenceController],
  // The handler registers itself into SyncRegistry on module init, so the sync
  // engine learns about evidence without importing it.
  providers: [EvidenceService, StorageService, EvidenceLinkSyncHandler],
  exports: [EvidenceService, StorageService],
})
export class EvidenceModule {}
