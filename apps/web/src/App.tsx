import { useEffect } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from './lib/session.js';
import { startSyncEngine } from './lib/offline/sync-engine.js';
import { routes } from './routes.js';

const router = createBrowserRouter(routes);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A site phone loses the network constantly. Retrying a read three times
      // over a dead connection just delays the cached answer.
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: 0 },
  },
});

export function App() {
  useEffect(() => startSyncEngine(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
