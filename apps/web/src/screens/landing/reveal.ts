import { useEffect } from 'react';

/**
 * Scroll reveal, from one observer for the whole page.
 *
 * An observer per element is the usual shortcut and it costs a callback per
 * element per intersection; one observer with a shared threshold does the same
 * job. Elements opt in with `data-reveal` and are unobserved once shown —
 * content that has appeared never needs watching again, and it must never
 * disappear on scroll-up.
 *
 * The initial hidden state lives in CSS behind `.js-reveal`, which this hook
 * sets on <html>. Without JavaScript, or before hydration, everything is
 * simply visible: content is never gated behind an animation.
 */
export function useReveal(): void {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof IntersectionObserver === 'undefined') {
      root.classList.remove('js-reveal');
      document.querySelectorAll('[data-reveal]').forEach((el) => el.setAttribute('data-shown', 'true'));
      return;
    }

    root.classList.add('js-reveal');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.setAttribute('data-shown', 'true');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    const targets = document.querySelectorAll('[data-reveal]:not([data-shown])');
    targets.forEach((el) => io.observe(el));

    return () => { io.disconnect(); root.classList.remove('js-reveal'); };
  }, []);
}
