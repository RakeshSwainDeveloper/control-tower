import { Body, Controller, Get, Param, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { ApprovalEngine } from './approval.engine.js';
import type { ApprovalDecision } from './approval.engine.js';
import { decideSchema, inboxSchema } from '../issues/issues.dto.js';

@Controller({ version: '1' })
export class ApprovalController {
  constructor(private readonly engine: ApprovalEngine) {}

  /**
   * The approver's inbox.
   *
   * Not gated on approval.instance.read: these are tasks assigned to the caller
   * by name. Somebody who can be asked to approve something can always see what
   * they have been asked to approve.
   */
  @Get('me/approvals')
  inbox(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(inboxSchema)) q: never,
  ) {
    const p = q as unknown as { projectId?: string; objectType?: string };
    return this.engine.inbox(
      { userId: u.userId, orgId: u.orgId },
      { projectId: p.projectId, objectType: p.objectType },
    );
  }

  @Post('approvals/:taskId/decide')
  @RequirePermission('approval.task.decide')
  decide(
    @CurrentUser() u: AuthenticatedUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body(new ZodValidationPipe(decideSchema)) body: never,
  ) {
    const b = body as unknown as { decision: ApprovalDecision; comment?: string };
    return this.engine.decide(
      {
        userId: u.userId, orgId: u.orgId,
        grantId: u.permissions.keys['approval.task.decide']?.grantId,
        responsibility: u.permissions.keys['approval.task.decide']?.responsibilityLabel,
      },
      taskId, { decision: b.decision, comment: b.comment },
    );
  }

  /**
   * FR-215 — the trail is visible to the person who submitted, not only to
   * approvers. "Where has my thing got to" is the single most common question
   * an approval workflow creates, and a system that cannot answer it just moves
   * the chasing from email into the app.
   */
  @Get('approvals/:objectType/:objectId/trail')
  @RequirePermission('approval.instance.read')
  trail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('objectType') objectType: string,
    @Param('objectId', ParseUUIDPipe) objectId: string,
  ) {
    return this.engine.trail({ userId: u.userId, orgId: u.orgId }, objectType, objectId);
  }
}
