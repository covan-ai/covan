import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase/client";
import { giveSecondFactor } from "@/lib/supabase/mfa";
import { readSession } from "@/lib/supabase/session";

/**
 * Where a page goes back to once the code is in. Only a path on this site:
 * anything else in `next` is somebody else's idea of where to send a person who
 * has just proved who they are.
 */
function safeNext(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

export const Route = createFileRoute("/two-factor")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: safeNext(search.next),
  }),
  component: TwoFactor,
});

/**
 * The second step of signing in, for an account with an authenticator.
 *
 * The password has already been accepted and a session is on disk, but it is
 * an `aal1` session and the database answers every request it makes with a 403
 * (0108). This page is the only thing it is good for.
 */
function TwoFactor() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Arriving without a half-finished session is arriving by mistake: with no
  // session there is nothing to finish, and a whole one has nothing left to do.
  // `unknown` keeps the form, as on /sign-in.
  useEffect(() => {
    let active = true;
    void readSession().then((answer) => {
      if (!active) return;
      if (answer.kind === "none") {
        navigate({ to: "/sign-in", replace: true });
      } else if (answer.kind === "session") {
        navigate({ to: next ?? "/app", replace: true });
      } else {
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [navigate, next]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s/g, "");

    setError(null);
    setSubmitting(true);
    try {
      await giveSecondFactor(code);
    } catch (cause) {
      setSubmitting(false);
      setError(cause instanceof Error ? cause.message : "That code did not work.");
      return;
    }
    navigate({ to: next ?? "/app", replace: true });
  }

  async function signInElsewhere() {
    await supabase.auth.signOut();
    navigate({ to: "/sign-in", replace: true });
  }

  return (
    <AuthLayout
      title="Enter your code"
      subtitle="Open your authenticator app and type the six-digit code it shows for Covan."
      footer={
        <button
          type="button"
          onClick={() => void signInElsewhere()}
          className="font-medium text-foreground hover:underline"
        >
          Sign in with a different account
        </button>
      }
    >
      {/* `method="post"` for the reason sign-in.tsx gives. */}
      <form method="post" onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="code">Authentication code</Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              placeholder="123 456"
              required
              autoFocus
              disabled={!ready}
              className="pl-9 tracking-widest"
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={!ready || submitting}>
          {submitting ? "Checking…" : "Continue"}
        </Button>

        <p className="text-xs text-muted-foreground">
          Lost your authenticator? Whoever runs this Covan can remove it, and you can then sign in
          with your password alone.
        </p>
      </form>
    </AuthLayout>
  );
}
