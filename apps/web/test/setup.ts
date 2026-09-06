import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

// jsdom has no crypto.randomUUID in older builds and no navigator.onLine
// setter. The outbox depends on both, so the harness supplies them rather than
// the production code carrying test-shaped fallbacks.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { ...globalThis.crypto, randomUUID: () => `${Math.random()}`.slice(2) },
  });
}

export function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

vi.stubGlobal('scrollTo', () => undefined);
