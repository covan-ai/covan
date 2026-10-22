import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase/client";
import { readSession } from "@/lib/supabase/session";
import { passwordStrength } from "@/lib/password-strength";

export const Route = createFileRoute("/reset-password")({
  component: ResetPassword,
});

/** Supabase reports invalid/expired links via an error in the URL hash or query. */
function readUrlError(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const desc = hash.get("error_description") ?? query.get("error_description");
  return desc ? decodeURIComponent(desc.replace(/\+/g, " ")) : null;
}

/** Matches the pause `_authed` takes between attempts, for the same reason. */
const RETRY_AFTER_MS = 3000;

function ResetPassword() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Supabase puts a rejected link's reason in the URL fragment before this
  // component ever renders, so it is known at mount and read here rather than
  // announced by an effect afterwards (#68). The rest of the effect below —
  // the auth subscription — is what an effect is for, and stays.
  const [urlError] = useState(readUrlError);
  const [error, setError] = useState<string | null>(urlError);
  const [status, setStatus] = useState<"checking" | "ready" | "invalid" | "done">(
    urlError ? "invalid" : "checking",
  );
  const [attempt, setAttempt] = useState(0);
  /** True while the link could be neither confirmed nor ruled out. */
  const [unreachable, setUnreachable] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    // An expired or already-used link. There is no token to wait for, so
    // subscribing would only keep a listener alive to hear nothing.
    if (urlError) return;

    let active = true;

    // The reset email link redirects here with a recovery token. supabase-js
    // (detectSessionInUrl, on by default) parses it and fires PASSWORD_RECOVERY,
    // establishing a short-lived session that authorizes updateUser().
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setStatus("ready");
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [urlError]);

  useEffect(() => {
    if (urlError) return;

    let active = true;

    // readSession() awaits client initialization, so the recovery token in the
    // URL has already been processed by the time this resolves.
    void readSession().then((answer) => {
      if (!active) return;
      if (answer.kind === "session") {
        setUnreachable(false);
        setEmail(answer.session.user?.email ?? null);
        setStatus("ready");
        return;
      }
      // A reset link proves the mailbox, not the authenticator, and GoTrue
      // will not change the password of an account with one until the code has
      // been given. The recovery session is kept; the code is asked for, and
      // this page picks up where it left off.
      if (answer.kind === "second-factor") {
        void navigate({ to: "/two-factor", search: { next: "/reset-password" }, replace: true });
        return;
      }
      // "Could not tell" is not "expired". Sending somebody to request a second
      // link because the check could not reach the server wastes the perfectly
      // good link in their hand — and reset links only last fifteen minutes.
      if (answer.kind === "unknown") {
        setUnreachable(true);
        return;
      }
      setUnreachable(false);
      setStatus((s) => (s === "checking" ? "invalid" : s));
    });

    return () => {
      active = false;
    };
  }, [urlError, attempt, navigate]);

  useEffect(() => {
    if (!unreachable) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreachable, attempt]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setSubmitting(false);
      setError(error.message);
      return;
    }

    // Sign the recovery session out so the user logs in fresh with the new password.
    await supabase.auth.signOut();
    setSubmitting(false);
    setStatus("done");
  }

  if (status === "done") {
    return (
      <AuthLayout
        title="Password saved"
        subtitle="Every session was signed out, this one too. Sign in with the new password."
      >
        <Button asChild size="lg" className="w-full">
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (status === "invalid") {
    return (
      <AuthLayout
        title="This link no longer works"
        subtitle="A reset link works for one hour and once."
      >
        {error && <p className="mt-0 mb-3 text-sm text-destructive">{error}</p>}
        <Button asChild size="lg" className="w-full">
          <Link to="/forgot-password">Send a new link</Link>
        </Button>
        <Button asChild variant="ghost" size="lg" className="mt-2 w-full">
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (status === "checking") {
    return (
      <AuthLayout title="Opening your reset link" subtitle="One moment.">
        <div className="flex min-h-16 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </AuthLayout>
    );
  }

  const strength = passwordStrength(password, MIN_PASSWORD);

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={
        <>
          {email ? (
            <>
              For <span className="font-medium text-foreground">{email}</span>.{" "}
            </>
          ) : null}
          Every session is signed out when you save, this one too.
        </>
      }
    >
      {/* method="post" for the reason spelled out in sign-in.tsx: submitted before
          hydration, a form with no method is a GET and puts what was typed in
          the URL. */}
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-meta">
            New password
          </Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <i
                key={i}
                className={`block h-1 flex-1 rounded-full ${i <= strength.segments ? "bg-foreground" : "bg-border"}`}
              />
            ))}
          </div>
          <p className="m-0 text-meta text-muted-foreground">{strength.words}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword" className="text-meta">
            Again, to be sure
          </Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? "text" : "password"}
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            className="h-9"
          />
        </div>

        {error && <p className="m-0 text-sm text-destructive">{error}</p>}

        <Button type="submit" size="lg" className="mt-1 w-full" disabled={submitting}>
          {submitting ? "Saving…" : "Save the password"}
        </Button>
      </form>
    </AuthLayout>
  );
}

const MIN_PASSWORD = 12;
