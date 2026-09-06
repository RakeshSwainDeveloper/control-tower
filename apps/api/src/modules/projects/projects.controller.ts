import {
  Body, Controller, Get, Param, Patch, Post, Query, ParseUUIDPipe,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission } from '../access/permission.decorator.js';
import { ProjectsService, type Actor } from './projects.service.js';
import { LocationsService } from './locations.service.js';
import { WorkItemsService } from './work-items.service.js';
import {
  createProjectSchema, updateProjectSchema, listProjectsSchema,
  createLocationSchema, bulkLocationsSchema, allocateSchema,
  createWorkItemSchema, importPreviewSchema,
} from './projects.dto.js';

const actorOf = (u: AuthenticatedUser): Actor => ({
  userId: u.userId, orgId: u.orgId, permissions: u.permissions,
});

const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().max(120).optional(),
});

const updateLocationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  levelName: z.string().max(40).optional(),
  status: z.enum(['not_started', 'in_progress', 'complete', 'handed_over']).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

@Controller({ version: '1' })
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly locations: LocationsService,
    private readonly workItems: WorkItemsService,
  ) {}

  // ── Projects ────────────────────────────────────────────────────
  @Get('projects')
  @RequirePermission('project.project.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(listProjectsSchema)) q: never,
  ) {
    return this.projects.list(actorOf(u), q);
  }

  @Post('projects')
  @RequirePermission('project.project.create')
  create(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(createProjectSchema)) body: never,
  ) {
    return this.projects.create(actorOf(u), body);
  }

  @Get('projects/:id')
  @RequirePermission('project.project.read')
  get(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(actorOf(u), id);
  }

  @Patch('projects/:id')
  @RequirePermission('project.project.update')
  update(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: never,
  ) {
    return this.projects.update(actorOf(u), id, body);
  }

  @Get('projects/:id/members')
  @RequirePermission('project.project.read')
  async members(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.projects.members(actorOf(u), id) };
  }

  // ── Locations ───────────────────────────────────────────────────
  @Get('projects/:id/locations')
  @RequirePermission('project.location.read')
  async tree(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.locations.tree(actorOf(u), id) };
  }

  @Get('projects/:id/locations/:locationId/subtree')
  @RequirePermission('project.location.read')
  async subtree(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
  ) {
    return { data: await this.locations.subtree(actorOf(u), id, locationId) };
  }

  @Post('projects/:id/locations')
  @RequirePermission('project.location.create')
  createLocation(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createLocationSchema)) body: never,
  ) {
    return this.locations.create(actorOf(u), id, body);
  }

  @Post('projects/:id/locations/bulk')
  @RequirePermission('project.location.create')
  bulkLocations(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(bulkLocationsSchema)) body: never,
  ) {
    return this.locations.bulkCreate(actorOf(u), id, body);
  }

  @Patch('projects/:id/locations/:locationId')
  @RequirePermission('project.location.update')
  updateLocation(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: never,
  ) {
    return this.locations.update(actorOf(u), id, locationId, body);
  }

  // ── Work items ──────────────────────────────────────────────────
  @Get('projects/:id/work-items')
  @RequirePermission('project.project.read')
  listWorkItems(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listQuerySchema)) q: never,
  ) {
    return this.workItems.list(actorOf(u), id, q);
  }

  @Post('projects/:id/work-items')
  @RequirePermission('project.work_item.manage')
  createWorkItem(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createWorkItemSchema)) body: never,
  ) {
    return this.workItems.create(actorOf(u), id, body);
  }

  @Get('projects/:id/work-items/:workItemId/allocations')
  @RequirePermission('project.project.read')
  allocations(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('workItemId', ParseUUIDPipe) workItemId: string,
  ) {
    return this.workItems.allocations(actorOf(u), id, workItemId);
  }

  @Post('projects/:id/work-items/:workItemId/allocations')
  @RequirePermission('project.work_item.manage')
  allocate(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('workItemId', ParseUUIDPipe) workItemId: string,
    @Body(new ZodValidationPipe(allocateSchema)) body: never,
  ) {
    return this.workItems.allocate(actorOf(u), id, workItemId, body);
  }

  // ── Import: three steps, nothing written before confirm ─────────
  @Post('projects/:id/work-items/import')
  @RequirePermission('project.work_item.import')
  importPreview(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(importPreviewSchema)) body: never,
  ) {
    return this.workItems.importPreview(actorOf(u), id, body);
  }

  @Post('projects/:id/work-items/import/:jobId/confirm')
  @RequirePermission('project.work_item.import')
  importConfirm(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.workItems.importConfirm(actorOf(u), id, jobId);
  }
}
