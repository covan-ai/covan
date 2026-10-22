import { createFileRoute, redirect } from "@tanstack/react-router";

/** Your account was split into Profile, Security and Preferences (A16). */
export const Route = createFileRoute("/_authed/settings/account")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/profile", replace: true });
  },
});
