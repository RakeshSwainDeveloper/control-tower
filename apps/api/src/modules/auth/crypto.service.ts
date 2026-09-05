import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Password, token and OTP primitives.
 *
 * argon2id for passwords — memory-hard, so a stolen table is expensive to
 * attack offline. Tokens and OTPs are compared with a constant-time function:
 * a plain `===` on a hash leaks length and prefix information through timing.
 */
@Injectable()
export class CryptoService {
  private static readonly ARGON = {
    memoryCost: 19_456,   // 19 MiB — OWASP baseline
    timeCost: 2,
    parallelism: 1,
  } as const;

  hashPassword(plain: string): Promise<string> {
    return argonHash(plain, CryptoService.ARGON);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    try {
      return await argonVerify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", never as an
      // exception that a caller might mistake for success.
      return false;
    }
  }

  /** Opaque, URL-safe secret. Only its SHA-256 is ever stored. */
  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** Numeric OTP. randomInt is CSPRNG-backed; Math.random is not. */
  generateOtp(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += randomInt(0, 10).toString();
    return out;
  }
}
