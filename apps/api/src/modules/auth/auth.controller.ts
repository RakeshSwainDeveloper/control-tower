import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PERMISSION_KEYS } from '@ct/contracts';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { Public, CurrentUser } from './public.decorator.js';
import { NoPermissionRequired } from '../access/permission.decorator.js';
import type { AuthenticatedUser } from './auth.guard.js';
import { loginSchema, otpRequestSchema, otpVerifySchema, refreshSchema } from './auth.dto.js';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string }, @Req() req: FastifyRequest) {
    return this.auth.loginWithPassword(body.email, body.password, ctxOf(req));
  }

  @Public()
  @Post('otp/request')
  requestOtp(@Body(new ZodValidationPipe(otpRequestSchema)) body: { phone: string }, @Req() req: FastifyRequest) {
    return this.auth.requestOtp(body.phone, ctxOf(req));
  }

  @Public()
  @Post('otp/verify')
  verifyOtp(@Body(new ZodValidationPipe(otpVerifySchema)) body: { phone: string; code: string }, @Req() req: FastifyRequest) {
    return this.auth.verifyOtp(body.phone, body.code, ctxOf(req));
  }

  @Public()
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: { refresh_token: string }, @Req() req: FastifyRequest) {
    return this.auth.refresh(body.refresh_token, ctxOf(req));
  }

  @NoPermissionRequired()
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.auth.logout(user.orgId, user.sessionId);
    return { ok: true };
  }

  /**
   * The compiled permission set the clients use to HIDE UI.
   *
   * It is never the enforcement point (FR-564) — every request is authorised
   * server-side regardless of what the client believes. `permission_version`
   * lets a client detect that its cached set is stale and refetch.
   */
  @NoPermissionRequired()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    const p = user.permissions;
    return {
      user_id: user.userId,
      org_id: user.orgId,
      permission_version: p.permissionVersion,
      permissions: Object.entries(p.keys).map(([key, scope]) => ({
        key,
        org_wide: scope.orgWide,
        project_ids: scope.projectIds,
        qualifier: scope.qualifier,
        responsibility: scope.responsibilityLabel,
      })),
      catalogue_size: PERMISSION_KEYS.length,
    };
  }
}

function ctxOf(req: FastifyRequest) {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    deviceId: req.headers['x-device-id'] as string | undefined,
  };
}
