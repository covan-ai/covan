import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Eye, EyeOff, Lock, Mail, User } from "lucide-react";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase/client";

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
});

function SignUp() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmailSent, setConfirmEmailSent] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "");
    const email = String(form.get("email") ?? "");
    const password = form.get("password");
    const confirmPassword = form.get("confirmPassword");

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setError(null);
    setSubmitting(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password: String(password ?? ""),
      options: { data: { name } },
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

    setConfirmEmailSent(true);
  }

  if (confirmEmailSent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="Confirm your account to get started."
        footer={
          <>
            Already have an account?{" "}
            <Link to="/sign-in" className="font-medium text-foreground hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          We sent a confirmation link to your email address. Click the link to activate your
          account, then sign in.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your team's brain"
      subtitle="Free forever plan. No credit card required."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Full name</Label>
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="name"
              name="name"
              type="text"
              placeholder="Alex Rivera"
              required
              autoComplete="name"
              className="pl-9"
            />
          </div>
        </div>

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
          <Label htmlFor="password">Password</Label>
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
          <Label htmlFor="confirmPassword">Confirm password</Label>
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

        <label className="flex items-start gap-2 text-sm text-muted-foreground">
          <Checkbox id="terms" required className="mt-0.5" /> I agree to the{" "}
          <a href="#" className="text-foreground hover:underline">
            Terms
          </a>{" "}
          and{" "}
          <a href="#" className="text-foreground hover:underline">
            Privacy Policy
          </a>
          .
        </label>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
