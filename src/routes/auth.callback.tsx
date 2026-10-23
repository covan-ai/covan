import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "@/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";
import { readSession } from "@/lib/supabase/session";

/**
 * Where Google and GitHub send a person back to.
 *
 * The provider hands them to GoTrue, and GoTrue to here, with the session in
 * the URL fragment. supabase-js reads it out itself (`detectSessionInUrl`)
 * before this component mounts — the same mechanics as `/confirmed` — so the
 * work is to wait for that and then get out of the way: to `/app`, or to
 * `/two-factor` for an account with an authenticator, which a provider's say-so
 * does not excuse from its code.
 *
 * Not `/sign-in` with the fragment on it, which would also have worked: that
 * page would paint its password form for the moment it takes to read the
 * session, and when the trip failed it would have nowhere to say why.
 *
 * It fails in a few ways worth naming, all of which GoTrue reports as
 * `error_description` in the query or the fragment: the person pressed Cancel
 * at the provider, the install does not take new sign-ups, or the provider
 * gave no address GoTrue could use.
 *
 * Like `/confirmed`, this URL has to be on the project's redirect allow-list or
 * GoTrue drops the person on the Site URL instead. `docs/self-hosting.md` says
 * where.
 */
export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
});

/** GoTrue reports a refused trip via an error in the URL hash or query. */
function readUrlError(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const desc = hash.get("error_description") ?? query.get("error_description");
  return desc ? decodeURIComponent(desc.replace(/\+/g, " ")) : null;
}

function AuthCallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [urlError] = useState(readUrlError);
  const [status, setStatus] = useState<"checking" | "none">("checking");

  useEffect(() => {
    if (urlError) return;
    let active = true;

    const forward = async () => {
      const answer = await readSession();
      if (!active) return false;
      if (answer.kind === "session") navigate({ to: "/app", replace: true });
      else if (answer.kind === "second-factor") navigate({ to: "/two-factor", replace: true });
      else return false;
      return true;
    };

    // Both halves, for the reason `/confirmed` gives: readSession covers the
    // ordinary case, the subscription a token that takes a moment longer.
    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") void forward();
    });

    void forward().then((went) => {
      if (active && !went) setStatus("none");
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [urlError, navigate]);

  if (urlError || status === "none") {
    return (
      <AuthLayout
        title={t("That didn't sign you in")}
        subtitle={
          urlError
            ? t("The provider sent you back without an account.")
            : t("There was nothing to finish.")
        }
        footer={
          <Link
            to="/sign-in"
            className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t("Back to sign in")}
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          {urlError && <p className="text-sm text-destructive">{urlError}</p>}
          <p className="text-sm text-muted-foreground">
            {t("Try again, or sign in with your email and password instead.")}
          </p>
          <Button asChild size="sm" className="mt-1">
            <Link to="/sign-in">{t("Sign in")}</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("Signing you in")} subtitle={t("One moment.")}>
      <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
        {t("Loading…")}
      </div>
    </AuthLayout>
  );
}
