import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Lock } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase/client";

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

function ResetPassword() {
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"checking" | "ready" | "invalid" | "done">("checking");

  useEffect(() => {
    let active = true;

    const urlError = readUrlError();
    if (urlError) {
      setStatus("invalid");
      setError(urlError);
      return;
    }

    // The reset email link redirects here with a recovery token. supabase-js
    // (detectSessionInUrl, on by default) parses it and fires PASSWORD_RECOVERY,
    // establishing a short-lived session that authorizes updateUser().
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setStatus("ready");
      }
    });

    // getSession() awaits client initialization, so the recovery token in the
    // URL has already been processed by the time this resolves.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        setStatus("ready");
      } else {
        setStatus((s) => (s === "checking" ? "invalid" : s));
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

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
        title="Password updated"
        subtitle="Your password has been changed."
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
          <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <p className="text-sm text-muted-foreground">
            You can now sign in with your new password.
          </p>
          <Button asChild size="sm" className="mt-1">
            <Link to="/sign-in">Sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (status === "invalid") {
    return (
      <AuthLayout
        title="Link expired"
        subtitle="This password reset link is invalid or has expired."
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-sm text-muted-foreground">
            Reset links expire after 15 minutes. Request a new one to continue.
          </p>
          <Button asChild size="sm" className="mt-1">
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (status === "checking") {
    return (
      <AuthLayout title="Reset your password" subtitle="Verifying your reset link…">
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose a strong password for your account."
      footer={
        <Link
          to="/sign-in"
          className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      }
    >
      {/* method="post" for the reason spelled out in sign-in.tsx: submitted before
          hydration, a form with no method is a GET and puts what was typed in
          the URL. */}
      <form method="post" onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              required
              minLength={8}
              autoComplete="new-password"
              className="px-9"
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
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              required
              minLength={8}
              autoComplete="new-password"
              className="pl-9"
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Updating…" : "Update password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
