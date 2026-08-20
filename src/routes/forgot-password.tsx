import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Mail, MailCheck } from "lucide-react";
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
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
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
        title="Check your inbox"
        subtitle="We sent a reset link if an account exists for that email."
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
            <MailCheck className="h-5 w-5" />
          </span>
          <p className="text-sm text-muted-foreground">
            A password reset link was sent to <span className="text-foreground">{sentTo}</span>. It
            expires in 15 minutes.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your work email and we'll send you a reset link."
      footer={
        <Link
          to="/sign-in"
          className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
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

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </AuthLayout>
  );
}
