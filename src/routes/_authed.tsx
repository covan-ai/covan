import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { api } from "@/lib/api-client";
import { onboardingRedirect } from "@/lib/onboarding-gate";

export const Route = createFileRoute("/_authed")({
  component: AuthedLayout,
});

function AuthedLayout() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (!data.session) {
        navigate({ to: "/sign-in" });
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (!nextSession) {
        navigate({ to: "/sign-in" });
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [navigate]);

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // The same ["me"] query AppShell already runs, so gating costs no extra
  // request — react-query serves both from one fetch.
  const {
    data: me,
    isError,
    isPending,
  } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    enabled: Boolean(session),
  });

  // `undefined` while loading, and deliberately `undefined` on failure too: a
  // /me that 404s must not lock the account into a wizard it cannot leave.
  const completed = isError ? undefined : me?.onboarding.completed;
  const redirect = onboardingRedirect({ pathname, completed });

  useEffect(() => {
    if (redirect) {
      void navigate({ to: redirect, replace: true });
    }
  }, [redirect, navigate]);

  // Waiting on `me` as well as the session. Painting /app for a beat and then
  // yanking it away is worse than one more moment on this screen — and
  // AppShell was going to wait on the same request to draw the sidebar anyway.
  // A failed /me stops the wait rather than extending it, so a broken account
  // reaches the app's own error handling instead of a spinner.
  if (!session || (isPending && !isError) || redirect) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  return <Outlet />;
}
