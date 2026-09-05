import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { PlatformController } from './platform.controller.js';
import { PlatformService } from './platform.service.js';
import { PlatformGuard } from './platform.guard.js';

@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
