import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { CurrentUser } from '../auth/public.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.guard.js';
import { NoPermissionRequired } from '../access/permission.decorator.js';

/**
 * Read-only reference data: categories, statuses, units.
 *
 * A READ surface, not an editor. `MVP_SCOPE.md` §6 is explicit that these
 * tables exist and their editors do not ship in the MVP — `config.masters.manage`
 * will gate writing when it arrives.
 *
 * Reading is gated on authentication alone. Everyone who can raise an issue
 * needs the category list, everyone who can record progress needs the units,
 * and a permission check here would only ever produce a screen with empty
 * chips and no explanation.
 */
@Controller({ version: '1' })
export class ConfigController {
  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  @NoPermissionRequired()
  @Get('master-data')
  async masterData(
    @CurrentUser() u: AuthenticatedUser,
    @Query('kind') kind?: string,
  ) {
    return withTenant(this.db, { orgId: u.orgId }, async (trx) => {
      let q = trx.selectFrom('app.master_data')
        .select(['id', 'kind', 'code', 'name', 'sort_order', 'is_active'])
        .where('is_active', '=', true)
        .orderBy('kind').orderBy('sort_order').orderBy('name');
      if (kind) q = q.where('kind', '=', kind);
      return { data: await q.execute() };
    });
  }

  /**
   * Configured status labels, with the state class each one means.
   *
   * The client colours by `state_class` and prints `label` (§4). Both are here
   * so it never has to guess one from the other.
   */
  @NoPermissionRequired()
  @Get('statuses')
  async statuses(
    @CurrentUser() u: AuthenticatedUser,
    @Query('entity_type') entityType?: string,
  ) {
    return withTenant(this.db, { orgId: u.orgId }, async (trx) => {
      let q = trx.selectFrom('app.statuses')
        .select(['id', 'entity_type', 'code', 'label', 'state_class',
                 'sort_order', 'is_default', 'is_terminal'])
        .orderBy('entity_type').orderBy('sort_order');
      if (entityType) q = q.where('entity_type', '=', entityType);
      return { data: await q.execute() };
    });
  }

  @NoPermissionRequired()
  @Get('units')
  async units(@CurrentUser() u: AuthenticatedUser) {
    return withTenant(this.db, { orgId: u.orgId }, async (trx) => ({
      data: await trx.selectFrom('app.units')
        .select(['id', 'code', 'name', 'decimal_places'])
        .orderBy('code').execute(),
    }));
  }
}
