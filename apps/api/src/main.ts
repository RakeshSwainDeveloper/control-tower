import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { VersioningType } from '@nestjs/common';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { AppModule } from './app.module.js';
import { loadEnv, corsOrigins } from './config/env.js';
import { createLogger } from './common/logger.js';
import { ProblemDetailFilter } from './common/problem.filter.js';
import { correlationHook } from './common/correlation.middleware.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 32 * 1024 * 1024 }),
    { bufferLogs: true },
  );

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Validation is Zod, applied per-handler via ZodValidationPipe, so that the
  // same schema in @ct/contracts drives both API validation and web form types.
  app.useGlobalFilters(new ProblemDetailFilter(logger));

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'If-Match',
      'Idempotency-Key', 'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Correlation-Id', 'ETag'],
  });

  app.getHttpAdapter().getInstance().addHook('onRequest', correlationHook);

  app.enableShutdownHooks();

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info(
    { port: env.API_PORT, env: env.NODE_ENV },
    `Control Tower API listening on :${env.API_PORT}/api/v1`,
  );
}

bootstrap().catch((err) => {
  console.error('Fatal: API failed to start');
  console.error(err);
  process.exit(1);
});
