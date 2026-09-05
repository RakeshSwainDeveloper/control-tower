import {
  Body, Controller, Delete, Get, Param, Post, Query, Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PERMISSION_KEYS, PERMISSION_MODULES, MVP_RECORD_QUALIFIERS } from '@ct/contracts';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Public } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { RequirePermission, NoPermissionRequired } from '../access/permission.decorator.js';
import { UsersService } from './users.service.js';
import { InvitationsService } from './invitations.service.js';
import {
  createUserSchema, listUsersSchema, createRoleSchema, grantSchema,
  inviteSchema, acceptInviteSchema,
} from './users.dto.js';

const actorOf = (u: AuthenticatedUser) => ({ userId: u.userId, orgId: u.orgId });

@Controller({ version: '1' })
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
  ) {}

  // ── Users ───────────────────────────────────────────────────────
  @Get('users')
  @RequirePermission('org.user.read')
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query(new ZodValidationPipe(listUsersSchema)) q: never,
  ) {
    return this.users.list(actorOf(u), q);
  }

  @Post('users')
  @RequirePermission('org.user.create')
  create(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(createUserSchema)) body: never,
  ) {
    return this.users.create(actorOf(u), body);
  }

  @Post('users/:id/deactivate')
  @RequirePermission('org.user.deactivate')
  deactivate(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    return this.users.deactivate(actorOf(u), id, body?.reason ?? 'no reason given');
  }

  // ── Roles ───────────────────────────────────────────────────────
  @Get('roles')
  @RequirePermission('org.role.read')
  listRoles(@CurrentUser() u: AuthenticatedUser) {
    return this.users.listRoles(actorOf(u));
  }

  @Post('roles')
  @RequirePermission('org.role.create')
  createRole(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(createRoleSchema)) body: never,
  ) {
    return this.users.createRole(actorOf(u), body);
  }

  /** The code-defined catalogue, for the role editor. Grouped by module so the
   *  editor can render sections rather than a flat list of 52 strings. */
  @Get('permissions')
  @RequirePermission('org.role.read')
  catalogue() {
    const grouped: Record<string, Array<{ key: string; resource: string; action: string }>> = {};
    for (const key of PERMISSION_KEYS) {
      const [module, resource, action] = key.split('.') as [string, string, string];
      (grouped[module] ??= []).push({ key, resource, action });
    }
    return {
      total: PERMISSION_KEYS.length,
      modules: PERMISSION_MODULES,
      qualifiers: MVP_RECORD_QUALIFIERS,
      permissions: grouped,
    };
  }

  // ── Grants ──────────────────────────────────────────────────────
  @Get('grants')
  @RequirePermission('org.grant.manage', 'org.user.read')
  listGrants(@CurrentUser() u: AuthenticatedUser, @Query('user_id') userId?: string) {
    return this.users.listGrants(actorOf(u), userId);
  }

  @Post('grants')
  @RequirePermission('org.grant.manage')
  grant(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(grantSchema)) body: never,
  ) {
    return this.users.grant(actorOf(u), body);
  }

  @Delete('grants/:id')
  @RequirePermission('org.grant.manage')
  revokeGrant(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reason') reason?: string,
  ) {
    return this.users.revokeGrant(actorOf(u), id, reason ?? 'no reason given');
  }

  // ── Invitations ─────────────────────────────────────────────────
  @Post('invitations')
  @RequirePermission('org.user.create')
  invite(
    @CurrentUser() u: AuthenticatedUser,
    @Body(new ZodValidationPipe(inviteSchema)) body: never,
  ) {
    return this.users.invite(actorOf(u), body);
  }

  @Delete('invitations/:id')
  @RequirePermission('org.user.create')
  revokeInvite(@CurrentUser() u: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.revokeInvitation(actorOf(u), id);
  }

  /** Public: the invitee has no account and no session yet. */
  @Public()
  @Get('invitations/preview')
  preview(@Query('token') token: string) {
    return this.invitations.preview(token ?? '');
  }

  @Public()
  @Post('invitations/accept')
  accept(
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: { token: string; password?: string },
    @Req() req: FastifyRequest,
  ) {
    return this.invitations.accept(body.token, body.password, req.ip);
  }
}
