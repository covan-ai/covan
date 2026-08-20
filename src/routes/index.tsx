import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase/client";

/*
 * `/` is a door, not a page.
 *
 * This build ships no marketing site: someone who has installed Covan on their
 * own server wants the product, not a pitch for it. So the root route decides
 * where they actually meant to go — the app if they have a session, sign-in if
 * they do not — and gets out of the way.
 *
 * The session lookup is the same client-side `getSession()` the `_authed`
 * layout uses, so the two never disagree about who is signed in.
 */
export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [{ title: "Covan" }],
  }),
});

function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      navigate({ to: data.session ? "/app" : "/sign-in", replace: true });
    });

    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading…</div>
    </div>
  );
}
