import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ApprovalEngine } from './approval.engine.js';
import { ApprovalController } from './approval.controller.js';

/**
 * The approval engine is a shared service, not a feature module.
 *
 * Any module with something to approve imports this one and calls submitInTrx.
 * BR-21 depends on that being the only path: if a module could set the approved
 * state class itself, the guarantee that every approval had a named human
 * behind it would be worth nothing.
 */
@Module({
  imports: [AccessModule],
  controllers: [ApprovalController],
  providers: [ApprovalEngine],
  exports: [ApprovalEngine],
})
export class ApprovalModule {}
