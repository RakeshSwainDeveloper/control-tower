import { Body, Controller, Get, Post, Query, Req, ParseUUIDPipe, Param } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission, NoPermissionRequired } from '../access/permission.decorator.js';
import { SyncService } from './sync.service.js';
import type { SyncActor } from './sync.types.js';

const batchSchema = z.object({
  items: z.array(z.object({
    client_uuid: z.string().uuid(),
    entity: z.string().min(2).max(60),
    op: z.enum(['create', 'update', 'transition']),
    payload: z.record(z.unknown()),
    device_ts: z.string().datetime().optional(),
    clock_skew_ms: z.coerce.number().int().optional(),
    base_version: z.coerce.number().int().optional(),
  })).min(1).max(200),
});

const pullSchema = z.object({
  entity: z.string().min(2).max(60),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  private actor(u: AuthenticatedUser, req: FastifyRequest): SyncActor {
    return {
      userId: u.userId, orgId: u.orgId,
      deviceId: (req.headers['x-device-id'] as string | undefined) ?? undefined,
    };
  }

  /**
   * Outbox ingest.
   *
   * Requires only that the caller can create field evidence: the per-entity
   * permission is the handler's business, and refusing the whole batch on one
   * unauthorised item would strand the other 49.
   */
  @Post('batch')
  @RequirePermission('field.evidence.create', 'field.progress.create', 'issue.issue.create')
  batch(
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(batchSchema)) body: { items: never[] },
  ) {
    return this.sync.ingest(this.actor(u, req), body.items);
  }

  @Get('manifest')
  @NoPermissionRequired()
  manifest(
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query('project_id') projectId?: string,
  ) {
    return this.sync.manifest(this.actor(u, req), projectId);
  }

  @Get('pull')
  @NoPermissionRequired()
  pull(
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query(new ZodValidationPipe(pullSchema)) q: { entity: string; cursor?: string; limit: number },
  ) {
    return this.sync.pull(this.actor(u, req), q.entity, q.cursor, q.limit);
  }

  /** FR-490/491: the user must never be left guessing whether work was saved. */
  @Get('needs-attention')
  @NoPermissionRequired()
  needsAttention(@CurrentUser() u: AuthenticatedUser, @Req() req: FastifyRequest) {
    return this.sync.needsAttention(this.actor(u, req));
  }

  @Post('needs-attention/:clientUuid/resolve')
  @NoPermissionRequired()
  resolve(
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Param('clientUuid', ParseUUIDPipe) clientUuid: string,
  ) {
    return this.sync.resolveAttention(this.actor(u, req), clientUuid);
  }

  @Get('conflicts')
  @RequirePermission('report.list.read')
  conflicts(
    @CurrentUser() u: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query('project_id') projectId?: string,
  ) {
    return this.sync.conflicts(this.actor(u, req), projectId);
  }
}
