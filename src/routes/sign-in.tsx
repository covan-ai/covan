import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Trans, useTranslation } from "@/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { OAuthButtons } from "@/components/oauth-buttons";
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

/** Dots, not words: what a password field shows before anything is typed. */
const PASSWORD_MASK = "••••••••••";

function SignIn() {
  const { t } = useTranslation();
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
      if (!active) return;
      // `replace`, so the back button goes wherever they came from rather than
      // to a sign-in page that will only bounce them here again. A session
      // still owing its code is half signed in, and the other half is
      // /two-factor, not a second password prompt.
      if (answer.kind === "session") navigate({ to: "/app", replace: true });
      else if (answer.kind === "second-factor") navigate({ to: "/two-factor", replace: true });
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

    // The password is only the whole of it for an account without an
    // authenticator; the rest are asked for a code next.
    const answer = await readSession();
    navigate({ to: answer.kind === "second-factor" ? "/two-factor" : "/app" });
  }

  return (
    <AuthLayout
      title={t("Sign in")}
      subtitle={t("Use the account your team invited.")}
      footer={
        <Trans
          t={t}
          i18nKey="New here? <a>Create a workspace</a>"
          components={{
            a: <Link to="/sign-up" className="font-medium text-foreground hover:underline" />,
          }}
        />
      }
    >
      <OAuthButtons remember={remember} onError={setError} />

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
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-meta">
            {t("Email")}
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder={t("you@company.com")}
            required
            autoComplete="email"
            className="h-9"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password" className="text-meta">
              {t("Password")}
            </Label>
            <Link
              to="/forgot-password"
              className="text-meta text-muted-foreground hover:text-foreground"
            >
              {t("Forgot it?")}
            </Link>
          </div>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder={PASSWORD_MASK}
              required
              autoComplete="current-password"
              className="h-9 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? t("Hide password") : t("Show password")}
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
          {t("Remember me")}
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" size="lg" className="mt-1 w-full" disabled={submitting}>
          {submitting ? t("Signing in…") : t("Sign in")}
        </Button>
      </form>
    </AuthLayout>
  );
}
