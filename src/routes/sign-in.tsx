import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase/client";
import { setRemember } from "@/lib/supabase/auth-storage";
import { readSession } from "@/lib/supabase/session";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRememberChecked] = useState(true);

  /*
   * A password prompt is the wrong answer to somebody who is already signed in.
   *
   * This page is where every other surface sends people — the landing page's
   * only button, a bookmark, the link in an invitation — and it used to ask for
   * a password regardless. That is the whole of the "it signs me out when I go
   * back to the home page" report: nothing had signed anybody out, the stored
   * session was sitting untouched in localStorage the entire time, and this
   * page simply never looked. Being asked to type your password again is
   * indistinguishable from having been signed out, so it was reported as one.
   *
   * Only a definite session forwards. `none` is the normal case and `unknown`
   * means the lookup could not complete — neither may replace the form, because
   * a lookup that cannot finish is exactly when somebody needs a way in.
   */
  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active || answer.kind !== "session") return;
      // `replace`, so the back button goes wherever they came from rather than
      // to a sign-in page that will only bounce them here again.
      navigate({ to: "/app", replace: true });
    });

    return () => {
      active = false;
    };
  }, [navigate]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    setError(null);
    setSubmitting(true);
    // Before the call, not after: signing in writes the session as it returns,
    // and the store it lands in has to be settled by then.
    setRemember(remember);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }

    navigate({ to: "/app" });
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Ask it anything your team wrote down."
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/sign-up" className="font-medium text-foreground hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      {/* `method="post"` matters even though `handleSubmit` calls
          preventDefault and this form is never posted anywhere.
          There is a window between the HTML arriving and React attaching that
          handler, and a submit inside it gets the browser's default — which,
          with no method, is a GET. The password ends up in the query string, in
          the address bar and in history:

            /sign-in?email=someone%40example.com&password=hunter2

          Not hypothetical; it happened on the first automated pass over the
          deployed site, filling and clicking faster than hydration. A cold
          cache or a slow connection is the same race with a person in it.
          POST puts it in a request body instead, where the page answers 200 and
          nothing is written down. The three other credential forms carry this
          for the same reason. */}
      <form method="post" onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Work email</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@company.com"
              required
              autoComplete="email"
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              required
              autoComplete="current-password"
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

        <label htmlFor="remember" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            id="remember"
            checked={remember}
            onCheckedChange={(next) => setRememberChecked(next === true)}
          />
          Remember me
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
