import { z } from 'zod';

/**
 * Environment contract. Parsed once at boot; a missing or malformed variable
 * fails the process immediately rather than at first use in production.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.coerce.boolean().default(false),
  TZ: z.string().default('Asia/Kolkata'),

  API_PORT: z.coerce.number().int().default(3000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_EVIDENCE: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  OTP_TTL_SECONDS: z.coerce.number().int().default(300),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_DEV_ECHO: z.coerce.boolean().default(false),

  SMTP_HOST: z.string().default('mailpit'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default('Control Tower <no-reply@controltower.local>'),

  // Evidence policy — FR-176/177/178
  EVIDENCE_MAX_PHOTO_BYTES: z.coerce.number().int().default(5_242_880),
  EVIDENCE_MAX_VIDEO_BYTES: z.coerce.number().int().default(15_728_640),
  EVIDENCE_MAX_VIDEO_SECONDS: z.coerce.number().int().default(30),
  EVIDENCE_GALLERY_MAX_AGE_HOURS: z.coerce.number().int().default(48),

  PLATFORM_BOOTSTRAP_EMAIL: z.string().email().optional(),
  PLATFORM_BOOTSTRAP_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}
