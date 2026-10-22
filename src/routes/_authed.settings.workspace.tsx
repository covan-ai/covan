import { createFileRoute, redirect } from "@tanstack/react-router";

/** Workspace settings were split by subject (A9); the name and model are General now. */
export const Route = createFileRoute("/_authed/settings/workspace")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});
