import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createDb } from '@ct/db';
import { loadEnv } from './config/env.js';
import { createLogger } from './common/logger.js';
import { DB_TOKEN, ENV_TOKEN, LOGGER_TOKEN } from './common/tokens.js';
import { AuditService } from './common/audit.service.js';
import { HealthModule } from './modules/health/health.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { EvidenceModule } from './modules/evidence/evidence.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { ApprovalModule } from './modules/approval/approval.module.js';
import { IssuesModule } from './modules/issues/issues.module.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { PermissionGuard } from './modules/access/permission.guard.js';

/**
 * Shared kernel. Domain modules (M1..M12) are added phase by phase and depend
 * on this; the kernel depends on no domain module. MVP_MODULE_MAP.md §4.
 */
@Global()
@Module({
  providers: [
    { provide: ENV_TOKEN, useFactory: () => loadEnv() },
    {
      provide: LOGGER_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: ReturnType<typeof loadEnv>) => createLogger(env),
    },
    {
      provide: DB_TOKEN,
      inject: [ENV_TOKEN, LOGGER_TOKEN],
      useFactory: (env: ReturnType<typeof loadEnv>, logger: ReturnType<typeof createLogger>) =>
        createDb({
          connectionString: env.DATABASE_URL,
          poolMax: env.DATABASE_POOL_MAX,
          onSlowQuery: (ms, q) => logger.warn({ ms, sql: q.slice(0, 300) }, 'slow query'),
        }),
    },
    AuditService,
  ],
  exports: [ENV_TOKEN, LOGGER_TOKEN, DB_TOKEN, AuditService],
})
export class CoreModule {}

/**
 * Guard ORDER is load-bearing and therefore declared in one place.
 *
 * Nest runs global guards in registration order. AuthGuard must populate
 * req.auth before PermissionGuard reads it; registering them in their own
 * modules made the order an accident of the import graph, and PermissionGuard
 * won — every authorised route answered "Not authenticated".
 *
 * Both are fail-closed: AuthGuard denies without @Public(), PermissionGuard
 * denies without @RequirePermission() or @NoPermissionRequired().
 */
@Module({
  imports: [CoreModule, AccessModule, AuthModule, TenancyModule, UsersModule, ProjectsModule, EvidenceModule, SyncModule, ProgressModule, ApprovalModule, IssuesModule,
    PlatformModule, HealthModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },        // 1st: who are you
    { provide: APP_GUARD, useClass: PermissionGuard },  // 2nd: may you
  ],
})
export class AppModule {}
