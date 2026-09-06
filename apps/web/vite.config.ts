import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Resolve @ct/contracts to TypeScript source in dev (matches tsx
  // --conditions=development on the API side).
  resolve: { conditions: ['development', 'browser', 'import', 'default'] },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    /**
     * Vite 6 rejects any Host header it does not recognise — a DNS-rebinding
     * protection — and answers with a bare "Blocked request. This host … is
     * not allowed." plus a 403. No console warning, no hint in the dev server
     * log: the page is simply blank.
     *
     * It bites anything that reaches the dev server by a name other than
     * localhost: the e2e browser using the compose service name `web`, a
     * phone on the LAN testing the site surface, a reverse proxy. Since this
     * is a dev server on a private network whose port is already published,
     * the names are listed rather than the protection disabled.
     *
     * DEV_ALLOWED_HOSTS takes a comma-separated list for anyone testing from
     * a real device.
     */
    allowedHosts: [
      'localhost', '127.0.0.1', 'web',
      ...(process.env['DEV_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    ],
    // Bind-mounted source over a Docker volume needs polling on some hosts.
    watch: { usePolling: true, interval: 300 },
    /**
     * Proxy /api to the API container, so the dev app is SAME-ORIGIN.
     *
     * The app previously used an absolute `http://localhost:3000/api/v1`, which
     * works from a developer's own browser and from nowhere else: the e2e
     * browser inside a container resolves `localhost:3000` to itself, and so
     * would a phone on the LAN testing the site surface.
     *
     * The proxy runs in the web container, where `api:3000` resolves, so both
     * a laptop browser and a container browser reach the same API by the same
     * relative path. Cross-origin behaviour is still exercised — the API's
     * CORS configuration is asserted directly in http-contract.test.ts, which
     * is where a header omission actually gets caught.
     */
    proxy: {
      '/api': {
        target: process.env['DEV_API_PROXY'] ?? 'http://api:3000',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
