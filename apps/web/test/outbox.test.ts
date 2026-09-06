/**
 * The outbox's promises to a supervisor with no signal.
 *
 * Every assertion here maps to something that would cost somebody their
 * morning's work if it were false.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as outbox from '../src/lib/offline/outbox.js';

async function wipe() {
  const d = await outbox.db();
  await d.clear('outbox');
  await d.clear('blobs');
  await d.clear('cache');
}

describe('offline outbox', () => {
  beforeEach(wipe);

  it('mints a client_uuid once and never regenerates it', async () => {
    const id = await outbox.enqueue({
      entity: 'progress_entry', payload: { reported_qty: '12' }, label: 'Wall plaster 12 sqm',
    });
    const [item] = await outbox.all();
    expect(item!.client_uuid).toBe(id);

    // The idempotency key survives a failed send and a retry. If it did not,
    // one timeout would become two entries on the ledger.
    await outbox.update(id, { state: 'sending', attempts: 1 });
    await outbox.update(id, { state: 'pending', attempts: 2, last_error: 'timeout' });
    const [again] = await outbox.all();
    expect(again!.client_uuid).toBe(id);
    expect(again!.attempts).toBe(2);
  });

  it('keeps an item that failed to send — nothing is dropped on error', async () => {
    const id = await outbox.enqueue({ entity: 'issue', payload: {}, label: 'Crack on C4' });
    await outbox.update(id, { state: 'attention', last_error: 'Project no longer accessible' });

    expect(await outbox.all()).toHaveLength(1);
    const attention = await outbox.needsAttention();
    expect(attention).toHaveLength(1);
    // The payload is preserved so the user can correct and resubmit without
    // re-entering anything (FR-491).
    expect(attention[0]!.payload).toBeDefined();
    expect(attention[0]!.last_error).toMatch(/no longer accessible/);
  });

  it('removes an item only on acknowledgement, and takes its photos with it', async () => {
    const id = await outbox.enqueue({ entity: 'progress_entry', payload: {}, label: 'x' });
    await outbox.attachBlob(id, new Blob(['jpeg']), {
      mime: 'image/jpeg', capturedAt: new Date().toISOString(), gpsLat: 12.97, gpsLng: 77.59,
    });
    expect(await outbox.blobsFor(id)).toHaveLength(1);

    await outbox.acknowledge(id);
    expect(await outbox.all()).toHaveLength(0);
    // An orphaned blob is invisible storage that never gets reclaimed on a
    // phone with 4GB of RAM and a full gallery.
    expect(await outbox.blobsFor(id)).toHaveLength(0);
  });

  it('orders the queue oldest-first, so the oldest age shown is the real one', async () => {
    const a = await outbox.enqueue({ entity: 'issue', payload: {}, label: 'first' });
    await outbox.update(a, { queued_at: 1_000 } as never);
    const b = await outbox.enqueue({ entity: 'issue', payload: {}, label: 'second' });
    await outbox.update(b, { queued_at: 2_000 } as never);
    const all = await outbox.all();
    expect(all.map((i) => i.label)).toEqual(['first', 'second']);
  });

  it('caches reference data so pickers work with no network', async () => {
    await outbox.putCache('locations:p1', [{ id: 'l1', name: 'Flat 502' }]);
    const got = await outbox.getCache<{ id: string; name: string }[]>('locations:p1');
    expect(got?.data[0]!.name).toBe('Flat 502');
    expect(got?.at).toBeGreaterThan(0);
  });

  it('notifies subscribers on every mutation, so the badge is never stale', async () => {
    let fired = 0;
    const stop = outbox.subscribe(() => { fired += 1; });
    const id = await outbox.enqueue({ entity: 'issue', payload: {}, label: 'x' });
    await outbox.update(id, { state: 'sending' });
    await outbox.acknowledge(id);
    stop();
    expect(fired).toBe(3);
  });
});

/**
 * The error a user sees when a request does not land.
 *
 * fetch() throws the same TypeError for a dead network, a refused connection
 * and a CORS rejection. Calling all of them "you appear to be offline" sent
 * somebody to check their wifi when the real cause was a missing
 * Access-Control-Allow-Headers on the server.
 */
describe('request failures are described honestly', () => {
  const setOnline = (v: boolean) =>
    Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

  it('says OFFLINE only when the browser is actually offline', async () => {
    const { request, ApiError } = await import('../src/lib/api.js');
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;

    setOnline(false);
    await expect(request('GET', '/anything')).rejects.toThrow(/offline/i);

    setOnline(true);
    try {
      await request('GET', '/anything');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as InstanceType<typeof ApiError>;
      expect(err.problem.title).toBe('Could not reach the server');
      expect(err.message).not.toMatch(/offline/i);
      // And it must not imply the user lost anything.
      expect(err.message).toMatch(/has been lost|Nothing you entered/i);
    }
    globalThis.fetch = original;
    setOnline(true);
  });
});
