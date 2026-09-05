import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../../config/env.js';
import { ENV_TOKEN } from '../../common/tokens.js';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;          // user id
  org: string;          // org id
  pv: number;           // permission_version — detects a stale client
  sid: string;          // session id
  typ: 'access';
}

@Injectable()
export class TokenService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshSecret: Uint8Array;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {
    this.accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
  }

  async signAccess(claims: Omit<AccessTokenClaims, 'typ'>): Promise<string> {
    return new SignJWT({ ...claims, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('control-tower')
      .setAudience('control-tower-api')
      .setExpirationTime(this.env.JWT_ACCESS_TTL)
      .sign(this.accessSecret);
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret, {
        issuer: 'control-tower',
        audience: 'control-tower-api',
      });
      if (payload['typ'] !== 'access') throw new Error('wrong token type');
      return payload as AccessTokenClaims;
    } catch {
      // Never echo the underlying reason: "expired" vs "bad signature" is a
      // useful distinction to an attacker and to nobody else.
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  accessTtlSeconds(): number {
    const m = /^(\d+)([smhd])$/.exec(this.env.JWT_ACCESS_TTL);
    if (!m) return 900;
    const n = Number(m[1]);
    return { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  }

  refreshTtlMs(): number {
    const m = /^(\d+)([smhd])$/.exec(this.env.JWT_REFRESH_TTL);
    if (!m) return 30 * 86400 * 1000;
    const n = Number(m[1]);
    return { s: n * 1e3, m: n * 6e4, h: n * 36e5, d: n * 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'];
  }
}
