import { Injectable, Inject, type OnApplicationBootstrap } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { PERMISSION_KEYS } from '@ct/contracts';
import { withoutTenant, type DB } from '@ct/db';
import { DB_TOKEN, LOGGER_TOKEN } from '../../common/tokens.js';

/**
 * Keeps app.permission_keys in step with the code catalogue.
 *
 * The catalogue is CODE, not configuration (FR-022). This table exists only so
 * role_permissions can carry a foreign key — which is what makes it impossible
 * for a tenant role to hold a key that no code checks.
 *
 * Sync is additive. Keys are marked deprecated, never deleted, because a
 * tenant role may still reference one and removing it would silently widen or
 * narrow that role (FR-064).
 */
@Injectable()
export class PermissionCatalogueService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(LOGGER_TOKEN) private readonly log: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { inserted, deprecated } = await this.sync();
    this.log.info(
      { total: PERMISSION_KEYS.length, inserted, deprecated },
      'permission catalogue synced',
    );
  }

  async sync(): Promise<{ inserted: number; deprecated: number }> {
    return withoutTenant(this.db, 'the permission catalogue is platform data', async (trx) => {
      const rows = PERMISSION_KEYS.map((key) => {
        const [module, resource, action] = key.split('.') as [string, string, string];
        return { key, module, resource, action, description: null, is_deprecated: false };
      });

      const res = await trx
        .insertInto('app.permission_keys')
        .values(rows)
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({ is_deprecated: false }),
        )
        .executeTakeFirst();

      // Anything in the table but no longer in code is deprecated, not dropped.
      const dep = await trx
        .updateTable('app.permission_keys')
        .set({ is_deprecated: true })
        .where('key', 'not in', PERMISSION_KEYS as unknown as string[])
        .where('is_deprecated', '=', false)
        .executeTakeFirst();

      return {
        inserted: Number(res.numInsertedOrUpdatedRows ?? 0),
        deprecated: Number(dep.numUpdatedRows ?? 0),
      };
    });
  }
}
