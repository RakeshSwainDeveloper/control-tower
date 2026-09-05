import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@ct/contracts';

export const REQUIRED_PERMISSIONS = 'ct:requiredPermissions';

/**
 * Declares the permission keys a route needs.
 *
 * The guard is GLOBAL and fails closed: an authenticated route with no
 * @RequirePermission is refused rather than allowed. Forgetting the decorator
 * therefore breaks the endpoint loudly in development instead of shipping an
 * unguarded one. Routes that genuinely need no key say so explicitly with
 * @NoPermissionRequired().
 */
export const RequirePermission = (...keys: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, keys);

export const NO_PERMISSION_REQUIRED = 'ct:noPermissionRequired';

/** For routes any authenticated user may call: /auth/me, /auth/logout. */
export const NoPermissionRequired = () => SetMetadata(NO_PERMISSION_REQUIRED, true);
