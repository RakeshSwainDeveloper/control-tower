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
    // Bind-mounted source over a Docker volume needs polling on some hosts.
    watch: { usePolling: true, interval: 300 },
  },
  build: { outDir: 'dist', sourcemap: true },
});
