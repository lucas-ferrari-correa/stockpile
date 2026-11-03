import { createFileRoute } from '@tanstack/react-router';
import { ApiStatus } from '@/features/health/api-status';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
      <ApiStatus />
    </section>
  );
}
