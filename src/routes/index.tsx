import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readSession } from "@/lib/supabase/session";

/*
 * `/` is a door, not a page.
 *
 * This build ships no marketing site: someone who has installed Covan on their
 * own server wants the product, not a pitch for it. So the root route decides
 * where they actually meant to go — the app if they have a session, sign-in if
 * they do not — and gets out of the way.
 *
 * The session lookup is the same client-side `readSession()` the `_authed`
 * layout uses, so the two never disagree about who is signed in — including
 * about the third answer, which is neither. `/` is where a bookmark lands, so
 * this is the most likely first page of a return visit; answering "sign in"
 * because the network hiccuped is how a bookmark turns into a password prompt.
 */
export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [{ title: "Covan" }],
  }),
});

/** Matches the pause `_authed` takes between attempts, for the same reason. */
const RETRY_AFTER_MS = 3000;

function Index() {
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active) return;
      if (answer.kind === "unknown") {
        setUnreachable(true);
        return;
      }
      navigate({ to: answer.kind === "session" ? "/app" : "/sign-in", replace: true });
    });

    return () => {
      active = false;
    };
  }, [navigate, attempt]);

  useEffect(() => {
    if (!unreachable) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreachable, attempt]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading…</div>
    </div>
  );
}
