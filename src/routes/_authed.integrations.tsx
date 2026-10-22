import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Integrations moved under Settings (A8). Kept as a redirect with its query
 * and hash intact: a provider's OAuth return lands here, and what it carries
 * is what the integrations page reads to finish the connection.
 */
export const Route = createFileRoute("/_authed/integrations")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/integrations",
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
});
