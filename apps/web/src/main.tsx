import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster, toast } from 'sonner';
import { router } from './app/router';
import { ApiError, errorMessage } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
    mutations: {
      onError: (e) => toast.error(errorMessage(e)),
    },
  },
  queryCache: new QueryCache({
    onError: (e, q) => {
      if (q.meta?.silent) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return;
      toast.error(errorMessage(e));
    },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" toastOptions={{ className: '!rounded-sm !border-line !font-sans' }} />
    </QueryClientProvider>
  </StrictMode>,
);
