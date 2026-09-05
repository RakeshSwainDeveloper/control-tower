import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrateUp, migrationStatus } from '@ct/db';
import { loadEnv } from '../config/env.js';

/**
 * Migration CLI. Runs as the ct_migrator role, not the app role, so the app
 * role never owns tables and therefore never bypasses RLS.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../packages/db/migrations');

function migratorUrl(appUrl: string): string {
  // ct_migrator shares the app password in dev (see infra/postgres/init).
  return appUrl.replace(/\/\/([^:]+):/, '//ct_migrator:');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const cmd = process.argv[2] ?? 'up';
  const url = migratorUrl(env.DATABASE_URL);
  const appRole = new URL(env.DATABASE_URL).username || 'ct_app';

  if (cmd === 'status') {
    const rows = await migrationStatus({
      connectionString: url, migrationsDir, appRole,
    });
    console.log('\n  version                    applied');
    console.log('  ─────────────────────────  ───────');
    for (const r of rows) {
      console.log(`  ${r.version.padEnd(25)}  ${r.applied ? '✔' : '·'}`);
    }
    const pending = rows.filter((r) => !r.applied).length;
    console.log(`\n  ${rows.length} total, ${pending} pending\n`);
    return;
  }

  if (cmd !== 'up') {
    console.error(`Unknown command '${cmd}'. Use: up | status`);
    process.exit(1);
  }

  console.log(`\n  Migrating ${new URL(url).pathname.slice(1)} …`);
  const applied = await migrateUp({
    connectionString: url,
    migrationsDir,
    appRole,
    logger: (m) => console.log(m),
  });
  console.log(
    applied.length
      ? `\n  ✔ Applied ${applied.length} migration(s)\n`
      : '\n  ✔ Already up to date\n',
  );
}

main().catch((err) => {
  console.error('\n  ✘ Migration failed:\n');
  console.error(`  ${(err as Error).message}\n`);
  process.exit(1);
});
