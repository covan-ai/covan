import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { shouldRetryQuery } from "./lib/query-retry";

export const getRouter = () => {
  // The retry rule is set here rather than per query, because the queries that
  // need it are the ones nobody thought about. A 401, a 403 or a 404 is an
  // answer; asking again a second later gets the same one. See query-retry.ts.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: shouldRetryQuery } },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
