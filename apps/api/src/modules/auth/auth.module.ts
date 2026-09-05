import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { CryptoService } from './crypto.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [AccessModule],
  controllers: [AuthController],
  providers: [AuthService, CryptoService, TokenService, AuthGuard],
  exports: [AuthService, CryptoService, TokenService, AuthGuard],
})
export class AuthModule {}
