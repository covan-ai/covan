import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { readSession } from "@/lib/supabase/session";
import { api } from "@/lib/api-client";
import { onboardingRedirect } from "@/lib/onboarding-gate";

export const Route = createFileRoute("/_authed")({
  component: AuthedLayout,
});

/**
 * How long to wait before asking again after a lookup that could not complete.
 *
 * Short, because the lookup it follows is not: supabase-js retries a failed
 * refresh for about twenty seconds before handing back an answer, so this delay
 * is a pause between attempts rather than the interval between them.
 */
const RETRY_AFTER_MS = 3000;

function AuthedLayout() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  /** True while the session could neither be found nor ruled out. */
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active) return;
      if (answer.kind === "session") {
        setSession(answer.session);
        setUnreachable(false);
        return;
      }
      // Only a definite "nobody is signed in" may take somebody's page away.
      // The third answer means the stored session is probably still good and
      // the network is not — see readSession for what that costs when ignored.
      if (answer.kind === "none") {
        setSession(null);
        navigate({ to: "/sign-in" });
        return;
      }
      setUnreachable(true);
    });

    return () => {
      active = false;
    };
  }, [navigate, attempt]);

  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // INITIAL_SESSION carries a null on exactly the failure readSession()
      // exists to recognise, and it is emitted whether or not the lookup
      // succeeded. Letting it through here would sign people out from the other
      // side of the same bug. Every other event is a real change of state.
      if (event === "INITIAL_SESSION") return;
      setSession(nextSession);
      if (nextSession) {
        setUnreachable(false);
      } else {
        navigate({ to: "/sign-in" });
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, [navigate]);

  // Keep asking. The refresh token is still on disk; all that is missing is a
  // working connection, and nothing else on this screen is going to notice when
  // one comes back.
  useEffect(() => {
    if (!unreachable) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreachable, attempt]);

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

  if (!session && unreachable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Can't reach Covan
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You're still signed in — this is a connection problem, not your account. Trying again on
            its own.
          </p>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try now
          </button>
        </div>
      </div>
    );
  }

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
