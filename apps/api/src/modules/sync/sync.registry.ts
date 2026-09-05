import { Injectable } from '@nestjs/common';
import type { SyncHandler } from './sync.types.js';

/**
 * The registry of offline-capable entities.
 *
 * MVP_SCOPE.md §4 M12c names five: progress entry, daily report, issue,
 * inspection, safety observation — plus evidence, which is offline-capable by
 * definition since the photo is taken where there is no signal.
 *
 * Phase 4 registers evidence. Phase 5 and 6 register the rest by calling
 * register() from their own modules; the engine does not change.
 */
@Injectable()
export class SyncRegistry {
  private readonly handlers = new Map<string, SyncHandler>();

  register(handler: SyncHandler): void {
    if (this.handlers.has(handler.entity)) {
      throw new Error(`Sync handler for '${handler.entity}' is already registered`);
    }
    this.handlers.set(handler.entity, handler);
  }

  get(entity: string): SyncHandler | undefined {
    return this.handlers.get(entity);
  }

  /** What a device is allowed to queue. Drives GET /sync/manifest. */
  entities(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
