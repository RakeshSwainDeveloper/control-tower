import { Module } from '@nestjs/common';
import { PermissionCatalogueService } from './permission-catalogue.service.js';
import { PermissionService } from './permission.service.js';
import { PermissionGuard } from './permission.guard.js';
import { SodService } from './sod.service.js';

/**
 * Guards are NOT registered here. Global guard order follows module
 * initialisation, and AuthModule imports AccessModule — so a guard registered
 * here would always run BEFORE authentication and see an empty req.auth.
 * Both guards are registered together, in explicit order, in AppModule.
 */
@Module({
  providers: [PermissionCatalogueService, PermissionService, PermissionGuard, SodService],
  exports: [PermissionCatalogueService, PermissionService, PermissionGuard, SodService],
})
export class AccessModule {}
