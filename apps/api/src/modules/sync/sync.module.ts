import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncRegistry } from './sync.registry.js';

@Module({
  imports: [AccessModule],
  controllers: [SyncController],
  // The registry is a singleton so handlers in other modules register into the
  // same instance the engine reads.
  providers: [SyncService, SyncRegistry],
  exports: [SyncService, SyncRegistry],
})
export class SyncModule {}
