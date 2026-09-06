import { Body, Controller, Get, Param, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission, NoPermissionRequired } from '../access/permission.decorator.js';
import { ApprovalEngine } from './approval.engine.js';
import { ApprovalConfigService } from './approval-config.service.js';
import type { StepSpec } from './approval.engine.js';
import type { ApprovalDecision } from './approval.engine.js';
import { decideSchema, inboxSchema } from '../issues/issues.dto.js';

const stepSchema = z.object({
  step_no: z.coerce.number().int().min(1).max(5),
  name: z.string().trim().min(2).max(80),
  resolver: z.enum(['role_in_project', 'project_manager']),
  role_code: z.string().trim().max(64).optional(),
  sla_hours: z.coerce.number().int().min(1).max(720).optional(),
  is_mandatory: z.boolean().optional(),
});

const createDefinitionSchema = z.object({
  objectType: z.string().trim().min(2).max(64),
  name: z.string().trim().min(2).max(120),
  scopeType: z.enum(['org', 'project']).default('org'),
  scopeId: z.string().uuid().optional(),
  steps: z.array(stepSchema).min(1).max(5),
}).strict().refine((v) => (v.scopeType === 'project') === !!v.scopeId, {
  message: 'A project-scoped workflow needs a scopeId; an org-scoped one takes none',
  path: ['scopeId'],
});

const publishSchema = z.object({ steps: z.array(stepSchema).min(1).max(5) }).strict();
const activeSchema = z.object({ isActive: z.boolean() }).strict();

@Controller({ version: '1' })
export class ApprovalController {
  constructor(
    private readonly engine: ApprovalEngine,
    private readonly config: ApprovalConfigService,
  ) {}

  /**
   * The approver's inbox.
   *
   * Not gated on approval.instance.read: these are tasks assigned to the caller
   * by name. Somebody who can be asked to approve something can always see what
   * they have been asked to approve.
   */
  @NoPermissionRequired()
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

  /* ── S-W10: approval configuration ─────────────────────────────
     Phase 6 shipped the engine and its tables with no way to fill them, so
     every submission would have failed BR-22 for ever. */

  @Get('approval-definitions')
  @RequirePermission('approval.definition.read')
  listDefinitions(
    @CurrentUser() u: AuthenticatedUser,
    @Query('object_type') objectType?: string,
  ) {
    return this.config.list({ userId: u.userId, orgId: u.orgId }, objectType)
      .then((data) => ({ data }));
  }

  @Post('approval-definitions')
  @RequirePermission('approval.definition.configure')
  createDefinition(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(createDefinitionSchema)) body: never,
  ) {
    const b = body as unknown as {
      objectType: string; name: string; scopeType: 'org' | 'project';
      scopeId?: string; steps: StepSpec[];
    };
    return this.config.createDefinition({ userId: u.userId, orgId: u.orgId }, b);
  }

  /** BR-20: this APPENDS a version. It never edits the one in force. */
  @Post('approval-definitions/:id/versions')
  @RequirePermission('approval.definition.configure')
  publish(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(publishSchema)) body: never,
  ) {
    return this.config.publish(
      { userId: u.userId, orgId: u.orgId }, id,
      (body as unknown as { steps: StepSpec[] }).steps,
    );
  }

  @Post('approval-definitions/:id/active')
  @RequirePermission('approval.definition.configure')
  setActive(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: never,
  ) {
    return this.config.setActive(
      { userId: u.userId, orgId: u.orgId }, id,
      (body as unknown as { isActive: boolean }).isActive,
    );
  }
}
