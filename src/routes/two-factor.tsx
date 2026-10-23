import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "@/i18n";
import { AuthLayout } from "@/components/auth-layout";
import { CodeInput } from "@/components/code-input";
import { Button } from "@/components/ui/button";
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [lostPhone, setLostPhone] = useState(false);

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
        if (answer.kind === "second-factor") setEmail(answer.session.user?.email ?? null);
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
      setError(cause instanceof Error ? cause.message : t("That code did not work."));
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
      title={t("Enter your code")}
      subtitle={t("From your authenticator app. It changes every 30 seconds.")}
      footer={
        email ? (
          <Trans
            t={t}
            i18nKey="Signing in as {{email}} · <a>Not you?</a>"
            values={{ email }}
            components={{
              a: (
                <button
                  type="button"
                  onClick={() => void signInElsewhere()}
                  className="font-medium text-foreground hover:underline"
                />
              ),
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => void signInElsewhere()}
            className="font-medium text-foreground hover:underline"
          >
            {t("Sign in with a different account")}
          </button>
        )
      }
    >
      {/* `method="post"` for the reason sign-in.tsx gives. */}
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <CodeInput name="code" value={code} onChange={setCode} disabled={!ready} />

        {error && <p className="m-0 text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={!ready || submitting || code.length < 6}
        >
          {submitting ? t("Checking…") : t("Verify")}
        </Button>

        <div className="text-right">
          <button
            type="button"
            onClick={() => setLostPhone((v) => !v)}
            className="text-meta text-muted-foreground hover:text-foreground"
          >
            {t("Lost your phone?")}
          </button>
        </div>
        {lostPhone ? (
          <p className="m-0 text-meta text-muted-foreground">
            {t(
              "Whoever runs this Covan can remove your authenticator, and you can then sign in with your password alone.",
            )}
          </p>
        ) : null}
      </form>
    </AuthLayout>
  );
}
