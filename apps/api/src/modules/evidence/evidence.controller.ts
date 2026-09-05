import {
  Body, Controller, Get, Param, Post, Query, ParseUUIDPipe,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { EvidenceService, type EvidenceActor } from './evidence.service.js';
import {
  presignSchema, completeSchema, linkSchema, unlinkSchema, listEvidenceSchema,
} from './evidence.dto.js';

const actorOf = (u: AuthenticatedUser): EvidenceActor => {
  const key = u.permissions.keys['field.evidence.create'];
  return {
    userId: u.userId, orgId: u.orgId,
    grantId: key?.grantId,
    responsibility: key?.responsibilityLabel,
  };
};

@Controller({ path: 'evidence', version: '1' })
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /** Phase 1 of the two-phase upload. Bytes go direct to storage, never here. */
  @Post('presign')
  @RequirePermission('field.evidence.create')
  presign(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignSchema)) body: never,
  ) {
    return this.evidence.presign(actorOf(u), body);
  }

  @Post(':id/complete')
  @RequirePermission('field.evidence.create')
  complete(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(completeSchema)) body: never,
  ) {
    return this.evidence.complete(actorOf(u), id, body);
  }

  @Post(':id/link')
  @RequirePermission('field.evidence.create')
  link(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(linkSchema)) body: never,
  ) {
    return this.evidence.link(actorOf(u), id, body);
  }

  /** Soft unlink with a mandatory reason. Never a delete. */
  @Post('links/:linkId/unlink')
  @RequirePermission('field.evidence.unlink')
  unlink(
    @CurrentUser() u: AuthenticatedUser,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @Body(new ZodValidationPipe(unlinkSchema)) body: { reason: string },
  ) {
    return this.evidence.unlink(actorOf(u), linkId, body.reason);
  }

  @Get(':id')
  @RequirePermission('field.evidence.read')
  get(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.evidence.getSignedUrl(actorOf(u), id);
  }

  @Get()
  @RequirePermission('field.evidence.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(listEvidenceSchema)) q: never,
  ) {
    return this.evidence.list(actorOf(u), q);
  }
}
