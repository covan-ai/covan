import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";

/** `minimum_password_length` in `supabase/config.toml`. GoTrue enforces it too. */
export const PASSWORD_MIN = 6;

/**
 * Changing your password, or setting one for an account that never had one.
 *
 * Unlike `reset-password.tsx`, this does not sign you out afterwards: that page
 * runs on a recovery session somebody may have opened from a forwarded email,
 * and this one runs on the session you are already using.
 */
export function PasswordCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= PASSWORD_MIN && password === confirm;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    const { error: authError } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setPassword("");
    setConfirm("");
    toast.success("Password updated");
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="space-y-1">
        <div className="font-dm text-title font-medium">Password</div>
        <p className="text-meta text-muted-foreground">
          Change it, or set one if you signed in another way.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <div className="relative">
          <Input
            id="new-password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {tooShort ? (
          <p className="text-xs text-destructive">At least {PASSWORD_MIN} characters.</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
        />
        {mismatch ? <p className="text-xs text-destructive">The two do not match.</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      <div className="flex justify-end border-t border-hairline pt-4">
        <Button onClick={save} disabled={saving || !ready}>
          {saving ? "Saving…" : "Update password"}
        </Button>
      </div>
    </SectionCard>
  );
}
