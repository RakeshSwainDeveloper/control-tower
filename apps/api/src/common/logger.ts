import pino, { type Logger } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Structured logging with a correlation id propagated across request, job and
 * sync (NFR-16). Every tenant-visible error carries a support reference that
 * maps back to a log entry (NFR-17).
 */
export function createLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'control-tower-api', env: env.NODE_ENV },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        '*.password_hash',
        'otp',
        '*.otp',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'S3_SECRET_KEY',
      ],
      censor: '[REDACTED]',
    },
    ...(env.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}
