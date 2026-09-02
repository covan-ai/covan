import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";

/**
 * Where the confirmation link in a new account's first email lands.
 *
 * It used to land on `/`, because that is what Supabase does when nothing tells
 * it otherwise: `emailRedirectTo` was never set, so GoTrue fell back to the
 * project's Site URL. On this build `/` is a redirect that reads the session and
 * forwards you to the app; on the hosted build it is the marketing page. Either
 * way the person who just clicked "Confirm my address" is looking at a page that
 * says nothing about whether the thing they clicked worked. The account was
 * confirmed. Nothing told them.
 *
 * So this page exists to be the answer to one question, and it answers it in
 * three ways rather than one, because the link can arrive in three states:
 *
 * - The session is there — confirmed, and there is a way into the app.
 * - Supabase put an error in the URL — expired or already used, said plainly,
 *   with the two things worth trying next.
 * - Neither — somebody has the URL open without a link behind it. Claiming an
 *   address was confirmed here would be a guess presented as a fact, so it says
 *   what it knows instead.
 *
 * The mechanics are `reset-password.tsx`'s, and for the same reason: supabase-js
 * parses the token out of the URL fragment itself (`detectSessionInUrl`, on by
 * default) before this component's effect ever runs, so the work is to wait for
 * that and report it, not to do it.
 *
 * One deployment step travels with this file: the URL has to be on the project's
 * redirect allow-list, next to `/reset-password`, or GoTrue ignores it and falls
 * back to the Site URL — which is exactly the behaviour this replaces, arriving
 * silently. `docs/self-hosting.md` says where.
 */
export const Route = createFileRoute("/confirmed")({
  component: Confirmed,
});

/** Supabase reports a rejected link via an error in the URL hash or query. */
function readUrlError(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const desc = hash.get("error_description") ?? query.get("error_description");
  return desc ? decodeURIComponent(desc.replace(/\+/g, " ")) : null;
}

function Confirmed() {
  // Read at mount rather than announced by an effect: the fragment is in the URL
  // before React renders, so a state that starts as "checking" and flips to
  // "invalid" a tick later is a spinner nobody needed to see.
  const [urlError] = useState(readUrlError);
  const [status, setStatus] = useState<"checking" | "confirmed" | "invalid" | "unknown">(
    urlError ? "invalid" : "checking",
  );

  useEffect(() => {
    if (urlError) return;

    let active = true;

    // Both halves are needed. getSession() resolves after the client has
    // finished with the URL, which covers the ordinary case; the subscription
    // covers a token that takes a moment longer to exchange, where getSession()
    // would otherwise have already answered "none" and settled on `unknown`.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session) setStatus("confirmed");
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setStatus((s) => (data.session ? "confirmed" : s === "checking" ? "unknown" : s));
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [urlError]);

  if (status === "checking") {
    return (
      <AuthLayout title="Confirming your address" subtitle="One moment.">
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </AuthLayout>
    );
  }

  if (status === "invalid") {
    return (
      <AuthLayout
        title="That link didn't work"
        subtitle="It has expired, or it had already been used."
        footer={
          <Link
            to="/sign-in"
            className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          {urlError && <p className="text-sm text-destructive">{urlError}</p>}
          <p className="text-sm text-muted-foreground">
            If you have confirmed this address already, sign in. If you have not, signing up again
            with the same address sends a new link.
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button asChild size="sm">
              <Link to="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/sign-up">Send a new link</Link>
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (status === "unknown") {
    return (
      <AuthLayout
        title="Confirm your address"
        subtitle="This page opens from the link in your confirmation email."
        footer={
          <Link
            to="/sign-in"
            className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <p className="text-sm text-muted-foreground">
            Open the email we sent and click the button in it. If you have already confirmed, you
            can sign in from here.
          </p>
          <Button asChild size="sm" className="mt-1">
            <Link to="/sign-in">Sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Address confirmed"
      subtitle="Your account is active and you are signed in."
      footer={
        <>
          Signed in on the wrong account?{" "}
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in as someone else
          </Link>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <p className="text-sm text-muted-foreground">
          If a colleague invited you, the invitation is matched to this address and is waiting
          inside.
        </p>
        <Button asChild size="sm" className="mt-1">
          <Link to="/app">Continue to Covan</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
