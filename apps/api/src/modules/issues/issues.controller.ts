import { Body, Controller, Get, Param, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { IssuesService, type IssueActor } from './issues.service.js';
import { ActionsService } from './actions.service.js';
import {
  raiseIssueSchema, assignIssueSchema, resolveIssueSchema, reopenIssueSchema,
  listIssuesSchema, createActionSchema, completeActionSchema, cancelActionSchema,
  commentSchema, answerSchema, threadSchema, myWorkSchema,
} from './issues.dto.js';

const actorOf = (u: AuthenticatedUser): IssueActor => ({
  userId: u.userId, orgId: u.orgId, permissions: u.permissions,
});

@Controller({ version: '1' })
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly actions: ActionsService,
  ) {}

  // ── Issues ──────────────────────────────────────────────────────
  @Post('projects/:id/issues')
  @RequirePermission('issue.issue.create')
  raise(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(raiseIssueSchema)) body: never,
  ) {
    return this.issues.raise(actorOf(u), id, body);
  }

  @Get('projects/:id/issues')
  @RequirePermission('issue.issue.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listIssuesSchema)) q: never,
  ) {
    return this.issues.list(actorOf(u), id, q);
  }

  @Get('projects/:id/issues/ageing')
  @RequirePermission('issue.issue.read')
  ageing(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.issues.ageing(actorOf(u), id);
  }

  @Post('projects/:id/issues/:issueId/assign')
  @RequirePermission('issue.issue.assign')
  assign(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body(new ZodValidationPipe(assignIssueSchema)) body: never,
  ) {
    const b = body as unknown as { assigneeUserId: string; dueDate?: string };
    return this.issues.assign(actorOf(u), id, issueId, b.assigneeUserId, b.dueDate);
  }

  @Post('projects/:id/issues/:issueId/resolve')
  @RequirePermission('issue.issue.resolve')
  resolve(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body(new ZodValidationPipe(resolveIssueSchema)) body: never,
  ) {
    return this.issues.resolve(actorOf(u), id, issueId, (body as unknown as { note: string }).note);
  }

  /** SoD-03 lives in the service — the guard here only checks the permission. */
  @Post('projects/:id/issues/:issueId/verify')
  @RequirePermission('issue.issue.verify')
  verify(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
  ) {
    return this.issues.verify(actorOf(u), id, issueId);
  }

  @Post('projects/:id/issues/:issueId/close')
  @RequirePermission('issue.issue.close')
  close(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
  ) {
    return this.issues.close(actorOf(u), id, issueId);
  }

  @Post('projects/:id/issues/:issueId/reopen')
  @RequirePermission('issue.issue.reopen')
  reopen(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body(new ZodValidationPipe(reopenIssueSchema)) body: never,
  ) {
    return this.issues.reopen(actorOf(u), id, issueId, (body as unknown as { reason: string }).reason);
  }

  // ── Actions (task / query / instruction) ────────────────────────
  @Post('projects/:id/actions')
  @RequirePermission('action.action.create')
  createAction(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createActionSchema)) body: never,
  ) {
    return this.actions.create(actorOf(u), id, body);
  }

  @Post('projects/:id/actions/:actionId/accept')
  @RequirePermission('action.action.read')
  accept(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.actions.accept(actorOf(u), id, actionId);
  }

  @Post('projects/:id/actions/:actionId/acknowledge')
  @RequirePermission('action.action.read')
  acknowledge(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return this.actions.acknowledge(actorOf(u), id, actionId);
  }

  @Post('projects/:id/actions/:actionId/complete')
  @RequirePermission('action.action.read')
  complete(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body(new ZodValidationPipe(completeActionSchema)) body: never,
  ) {
    return this.actions.complete(actorOf(u), id, actionId, (body as unknown as { note?: string }).note);
  }

  @Post('projects/:id/actions/:actionId/cancel')
  @RequirePermission('action.action.create')
  cancelAction(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body(new ZodValidationPipe(cancelActionSchema)) body: never,
  ) {
    return this.actions.cancel(actorOf(u), id, actionId, (body as unknown as { reason: string }).reason);
  }

  // ── Comments & queries ──────────────────────────────────────────
  @Post('projects/:id/comments')
  @RequirePermission('action.action.create')
  comment(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: never,
  ) {
    return this.actions.comment(actorOf(u), id, body);
  }

  @Post('projects/:id/comments/:commentId/answer')
  @RequirePermission('action.action.read')
  answer(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body(new ZodValidationPipe(answerSchema)) body: never,
  ) {
    return this.actions.answerQuery(
      actorOf(u), id, commentId, (body as unknown as { answer: string }).answer,
    );
  }

  @Get('projects/:id/comments')
  @RequirePermission('action.action.read')
  thread(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(threadSchema)) q: never,
  ) {
    const p = q as unknown as { entityType: string; entityId: string };
    return this.actions.thread(actorOf(u), id, p.entityType, p.entityId);
  }

  // ── My Work ─────────────────────────────────────────────────────
  /**
   * Deliberately NOT permission-gated beyond authentication: it returns only
   * rows already addressed to the caller. A permission check here would hide a
   * person's own inbox from them after a role change, which is the one place
   * that must never happen.
   */
  @Get('me/work')
  myWork(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(myWorkSchema)) q: never,
  ) {
    return this.actions.myWork(actorOf(u), q);
  }
}
