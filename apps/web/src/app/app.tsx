import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { createAppRouter } from './router';

interface AppProps {
  queryClient: QueryClient;
  history?: RouterHistory;
}

export function App({ queryClient, history }: AppProps): ReactElement {
  const [router] = useState(() => createAppRouter(queryClient, history));

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
