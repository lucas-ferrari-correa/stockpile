import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

function renderAt(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<App queryClient={queryClient} history={createMemoryHistory({ initialEntries: [path] })} />);
}

function stubFetch(response: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the home route with the api status from the health endpoint', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ status: 'ok', checks: { database: 'up', redis: 'up' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Products' })).toBeInTheDocument();
    expect(await screen.findByText('API ok')).toBeInTheDocument();
  });

  it('shows the unreachable state with a retry action when the api fails', async () => {
    stubFetch(() => new Response('down', { status: 503 }));

    renderAt('/');

    expect(await screen.findByText('API unreachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
