import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase/client";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
});

function ForgotPassword() {
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await send(String(new FormData(e.currentTarget).get("email") ?? ""));
  }

  async function send(email: string) {
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);

    if (error) {
      setError(error.message);
      return;
    }

    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle={
          <>
            If <span className="font-medium text-foreground">{sentTo}</span> has an account, a link
            is on its way. It works for one hour and once.
          </>
        }
      >
        <p className="mt-0 mb-3.5 text-meta leading-[1.5] text-muted-foreground">
          Nothing arrived? Look in spam, or try again in a minute. We say the same thing whether or
          not the address exists.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="w-full"
          disabled={submitting}
          onClick={() => void send(sentTo)}
        >
          {submitting ? "Sending…" : "Send it again"}
        </Button>
        <Button asChild variant="ghost" size="lg" className="mt-2 w-full">
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Tell us the address and we send a link that works for one hour."
    >
      {/* method="post" for the reason spelled out in sign-in.tsx: submitted before
          hydration, a form with no method is a GET and puts what was typed in
          the URL. */}
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-meta">
            Email
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
        </div>

        {error && <p className="m-0 text-sm text-destructive">{error}</p>}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "Sending…" : "Send the link"}
        </Button>
        <Button asChild variant="ghost" size="lg" className="w-full">
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </form>
    </AuthLayout>
  );
}
