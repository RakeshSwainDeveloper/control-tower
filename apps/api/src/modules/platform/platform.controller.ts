import {
  Body, Controller, Delete, Get, Param, Post, Query, UseGuards,
  ParseUUIDPipe, createParamDecorator, type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public } from '../auth/public.decorator.js';
import { PlatformService, type PlatformActor } from './platform.service.js';
import { PlatformGuard } from './platform.guard.js';
import { TokenService } from '../auth/token.service.js';

const CurrentPlatformUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): PlatformActor => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!req.platform) throw new Error('CurrentPlatformUser used without PlatformGuard');
    return req.platform;
  },
);

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const createOrgSchema = z.object({
  legalName: z.string().min(2).max(200),
  displayName: z.string().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
});
const statusSchema = z.object({
  status: z.enum(['trial', 'active', 'suspended', 'read_only', 'closed']),
  reason: z.string().min(3).max(500),
});
const impersonateSchema = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  reason: z.string().min(10).max(500),
  minutes: z.coerce.number().int().min(5).max(60).default(30),
});
const flagSchema = z.object({
  flagKey: z.string().min(3).max(64),
  enabled: z.boolean(),
  reason: z.string().min(3).max(500),
});

/**
 * The Super Admin surface.
 *
 * @Public() opts out of the TENANT auth guard; PlatformGuard then applies the
 * platform identity domain instead. The two never overlap: a tenant token is
 * structurally invalid here and a platform token carries no org, so it can
 * satisfy nothing on the tenant side.
 */
@Public()
@Controller({ path: 'platform', version: '1' })
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly tokens: TokenService,
  ) {}

  @Post('login')
  async login(@Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string }) {
    const user = await this.platform.login(body.email, body.password);
    const token = await this.tokens.signAccess({
      sub: user.id, org: 'platform', pv: 1, sid: user.id,
    });
    return { access_token: token, token_type: 'Bearer', user };
  }

  @UseGuards(PlatformGuard)
  @Get('organizations')
  listOrgs(@CurrentPlatformUser() a: PlatformActor) {
    return this.platform.listOrganizations(a);
  }

  @UseGuards(PlatformGuard)
  @Post('organizations')
  createOrg(
    @CurrentPlatformUser() a: PlatformActor,
    @Body(new ZodValidationPipe(createOrgSchema)) body: never,
  ) {
    return this.platform.createOrganization(a, body);
  }

  @UseGuards(PlatformGuard)
  @Post('organizations/:id/status')
  setStatus(
    @CurrentPlatformUser() a: PlatformActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: { status: never; reason: string },
  ) {
    return this.platform.setOrganizationStatus(a, id, body.status, body.reason);
  }

  @UseGuards(PlatformGuard)
  @Get('organizations/:id/users')
  orgUsers(@CurrentPlatformUser() a: PlatformActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.platform.listOrgUsers(a, id);
  }

  @UseGuards(PlatformGuard)
  @Post('organizations/:id/flags')
  setFlag(
    @CurrentPlatformUser() a: PlatformActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(flagSchema)) body: { flagKey: string; enabled: boolean; reason: string },
  ) {
    return this.platform.setOrgFlag(a, id, body.flagKey, body.enabled, body.reason);
  }

  @UseGuards(PlatformGuard)
  @Get('flags')
  flags() {
    return this.platform.listFlags();
  }

  @UseGuards(PlatformGuard)
  @Post('impersonation')
  impersonate(
    @CurrentPlatformUser() a: PlatformActor,
    @Body(new ZodValidationPipe(impersonateSchema)) body: never,
  ) {
    return this.platform.startImpersonation(a, body);
  }

  @UseGuards(PlatformGuard)
  @Delete('impersonation/:id')
  endImpersonation(@CurrentPlatformUser() a: PlatformActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.platform.endImpersonation(a, id);
  }

  @UseGuards(PlatformGuard)
  @Get('impersonation')
  listImpersonations(@CurrentPlatformUser() a: PlatformActor) {
    return this.platform.listImpersonations(a);
  }

  @UseGuards(PlatformGuard)
  @Get('audit')
  audit(@Query('limit') limit?: string) {
    return this.platform.platformAuditLog(Math.min(Number(limit ?? 100), 500));
  }
}
