import { writeFile } from 'node:fs/promises';
import { Worker, Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'kysely';
import { createDb, withoutTenant } from '@ct/db';
import { loadEnv } from '../../api/src/config/env.js';
import { createLogger } from '../../api/src/common/logger.js';
import { QUEUES, maintenanceJobSchema, type MaintenanceJob } from './queues.js';

const env = loadEnv();
const log = createLogger(env).child({ service: 'control-tower-worker' });

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = createDb({ connectionString: env.DATABASE_URL, poolMax: 5 });

/**
 * Partition maintenance. A missing future partition on audit_log is a classic
 * 2am outage, so we run three months ahead, hourly, and log loudly.
 */
async function ensurePartitions(): Promise<void> {
  await withoutTenant(db, 'partition maintenance is tenant-less DDL', async (trx) => {
    for (let i = -1; i <= 3; i++) {
      const monthStart = sql<string>`(date_trunc('month', now()) + (${i} || ' month')::interval)::date`;
      await sql`SELECT app.ensure_month_partition('app.audit_log'::regclass, ${monthStart})`.execute(trx);
    }
  });
  log.debug('audit_log partitions ensured through +3 months');
}

async function handleMaintenance(job: Job<MaintenanceJob>): Promise<void> {
  const payload = maintenanceJobSchema.parse(job.data);
  switch (payload.task) {
    case 'ensure_partitions':
      return ensurePartitions();
    case 'sweep_overdue':
    case 'purge_sync_operations':
      log.debug({ task: payload.task }, 'no-op until its module ships');
      return;
  }
}

/**
 * Liveness heartbeat.
 *
 * A container healthcheck on `worker` is not optional: the dev command is
 * `tsx watch`, so when main() throws the script dies while the CONTAINER stays
 * Up. `docker compose ps` then shows a healthy worker that is processing
 * nothing. Writing the file only after a successful Redis round-trip means the
 * heartbeat proves the event loop AND the queue connection, not just a live PID.
 */
const HEARTBEAT_PATH = '/tmp/worker-alive';

async function beat(): Promise<void> {
  await connection.ping();
  await writeFile(HEARTBEAT_PATH, String(Date.now()), 'utf8');
}

async function main(): Promise<void> {
  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection });

  // Repeatable: partitions hourly. Idempotent by construction.
  await maintenanceQueue.upsertJobScheduler(
    'ensure-partitions',
    { pattern: '0 * * * *' },
    { name: 'ensure_partitions', data: { task: 'ensure_partitions' } },
  );

  new Worker(QUEUES.maintenance, handleMaintenance, { connection, concurrency: 1 })
    .on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'maintenance job failed'))
    .on('completed', (job) => log.debug({ job: job.name }, 'maintenance job done'));

  // Run once at boot so a fresh stack is immediately correct.
  await ensurePartitions();

  await beat();
  const heartbeat = setInterval(() => {
    beat().catch((err) => log.error({ err }, 'heartbeat failed'));
  }, 10_000);
  heartbeat.unref();

  log.info({ queues: Object.values(QUEUES) }, 'Control Tower worker started');
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await connection.quit().catch(() => undefined);
  await db.destroy().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  process.exit(1);
});
