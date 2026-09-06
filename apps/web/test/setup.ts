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

// jsdom implements neither of these. The landing page's scroll hook and the
// skeletons both ask about reduced motion; without a stub every test that
// renders them fails on the environment rather than on the code.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number);
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id));
}
