import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * Renders a settings route's component with a fresh query client. The route
 * object comes from the module under test, whose `createFileRoute` the test has
 * mocked to hand its options straight back.
 */
export function renderRoute(route: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = (route as { component: () => React.ReactElement }).component;
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

/** Stands a section in for a test that is about where it goes, not what it does. */
export function stub(testId: string) {
  return () => <div data-testid={testId} />;
}
