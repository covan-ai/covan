import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { OAuthButtons } from "@/components/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/status-dot";
import { supabase } from "@/lib/supabase/client";
import { setRemember } from "@/lib/supabase/auth-storage";
import { readSession } from "@/lib/supabase/session";
import { privacyLink, termsLink } from "@/lib/legal";
import { LegalAnchor } from "@/components/legal-anchor";

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
});

function SignUp() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The address, not a boolean: "check your email" is advice, and which inbox to
  // check is the part of it that is actually information.
  const [sentTo, setSentTo] = useState<string | null>(null);

  /*
   * The same door as the sign-in page's, and it needs the same answer.
   *
   * "Get started" is the landing page's only call to action, so this is where a
   * signed-in person who typed the bare domain lands. A blank sign-up form is
   * the loudest possible way to tell somebody they have been signed out, and
   * they have not been — see the note on the sign-in page for the report this
   * closes. Only a definite session forwards; see there for why the other two
   * answers leave the form alone.
   */
  useEffect(() => {
    let active = true;

    void readSession().then((answer) => {
      if (!active || answer.kind !== "session") return;
      navigate({ to: "/app", replace: true });
    });

    return () => {
      active = false;
    };
  }, [navigate]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const workspaceName = String(form.get("workspace") ?? "").trim();
    const email = String(form.get("email") ?? "");
    const password = form.get("password");

    setError(null);
    setSubmitting(true);
    // This page has no "Remember me" box, so without this it inherits whatever
    // the last sign-in on this machine answered — and a cleared box is sticky.
    // A new account would then be confined to the tab that made it. Before the
    // call, like sign-in: a deployment that confirms nothing hands back a
    // session as this returns, and the store has to be settled by then.
    setRemember(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password: String(password ?? ""),
      options: {
        // Carried to the first run, whose first step names the workspace the
        // sign-up made (`WorkspaceStep` reads it back). A default the person
        // can change on the next screen, and trusted for nothing else.
        data: workspaceName ? { workspace_name: workspaceName } : {},
        // Without this, GoTrue sends the confirmation link to the project's Site
        // URL — `/`, which is a redirect here and a marketing page on the hosted
        // build, and in both cases a page with nothing to say about the click
        // that led to it. `/confirmed` is that missing sentence. It has to be on
        // the project's redirect allow-list or GoTrue silently falls back to the
        // Site URL again; see `src/routes/confirmed.tsx`.
        emailRedirectTo: `${window.location.origin}/confirmed`,
      },
    });
    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }

    if (data.session) {
      navigate({ to: "/app" });
      return;
    }

    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthLayout
        title="Confirm your address"
        subtitle={
          <>
            We sent a link to <span className="font-medium text-foreground">{sentTo}</span>. Open it
            on any device to finish.
          </>
        }
        footer={
          <>
            Already have one?{" "}
            <Link to="/sign-in" className="font-medium text-foreground hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
          <StatusDot state="waiting" />
          <span className="text-sm">Waiting for the link to be opened</span>
        </div>
      </AuthLayout>
    );
  }

  // The subtitle used to read "Free forever plan. No credit card required.",
  // which implied there was a paid one to compare it against. There is not — no
  // tiers, no checkout, nothing to upgrade to. It also has to be true on both
  // builds, and this screen cannot tell them apart: it renders before there is a
  // session, so the usage call that would say whether this install meters
  // anything is not available to it. Hence a sentence that needs neither.
  return (
    <AuthLayout
      title="Create a workspace"
      subtitle="Your team, your agents, your documents. Free to start."
      footer={
        <>
          Already have one?{" "}
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {/* Remembered, as the email form below is: this page has no box to
          clear. The consent sentence is the card's own, under the form. */}
      <OAuthButtons remember consent={false} onError={setError} />

      {/* method="post" for the reason spelled out in sign-in.tsx: submitted before
          hydration, a form with no method is a GET and puts what was typed in
          the URL. */}
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="workspace" className="text-meta">
            Workspace name
          </Label>
          <Input
            id="workspace"
            name="workspace"
            type="text"
            placeholder="Acme"
            maxLength={100}
            autoComplete="organization"
            className="h-9"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-meta">
            Work email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="you@company.com"
            required
            autoComplete="email"
            className="h-9"
          />
          {/* No `?email=` prefill here, and the invitation mail does not send
              one — see `src/lib/invite-text.ts` and docs/team.md. A link that
              fills the field in gets forwarded in place of the address, and the
              person who follows it signs up as somebody else. */}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-meta">
            Password
          </Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder={`At least ${MIN_PASSWORD} characters`}
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
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
        </div>

        {error && <p className="m-0 text-sm text-destructive">{error}</p>}

        <Button type="submit" size="lg" className="mt-1 w-full" disabled={submitting}>
          {submitting ? "Creating…" : "Create workspace"}
        </Button>
      </form>

      {/* Where these point is configurable, because an operator running Covan
          for other people needs their own documents and a self-hoster does
          not. See `src/lib/legal.ts`. */}
      <p className="mt-4 mb-0 text-meta leading-[1.5] text-muted-foreground">
        By continuing you agree to the{" "}
        <LegalAnchor link={termsLink()} newTab>
          Terms
        </LegalAnchor>{" "}
        and the{" "}
        <LegalAnchor link={privacyLink()} newTab>
          Privacy policy
        </LegalAnchor>
        . We email you once to confirm the address.
      </p>
    </AuthLayout>
  );
}

/** What the form asks for; GoTrue's own minimum is lower and still applies. */
const MIN_PASSWORD = 12;
