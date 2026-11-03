import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { healthQueryOptions } from './health-query';

export function ApiStatus(): ReactElement {
  const { data, isPending, isError, refetch, isFetching } = useQuery(healthQueryOptions());

  const label = isPending ? 'Checking API…' : isError ? 'API unreachable' : `API ${data.status}`;

  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
        <RefreshCw />
        Retry
      </Button>
    </div>
  );
}
