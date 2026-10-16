import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";

/**
 * Eight, as sign-up and the reset page already ask. `minimum_password_length`
 * in `supabase/config.toml` says the same, so GoTrue enforces it too.
 */
export const PASSWORD_MIN = 8;

/**
 * Changing your password, or setting one for an account that never had one.
 *
 * Unlike `reset-password.tsx`, this does not sign you out afterwards: that page
 * runs on a recovery session somebody may have opened from a forwarded email,
 * and this one runs on the session you are already using.
 *
 * Which is exactly why GoTrue may ask for more. With `secure_password_change`
 * on, a session that did not sign in within the last day cannot change the
 * password on its own say-so — otherwise a laptop left open, or a stolen
 * session, could lock the owner out. GoTrue answers `reauthentication_needed`;
 * this card asks GoTrue to email a code, and sends the change again with it.
 * Nobody who signed in recently ever sees that step.
 */
export function PasswordCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once GoTrue has asked for a code and one has been sent. */
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready =
    password.length >= PASSWORD_MIN && password === confirm && (!needsCode || code.trim() !== "");

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    const { error: authError } = await supabase.auth.updateUser(
      needsCode ? { password, nonce: code.trim() } : { password },
    );

    if (authError?.code === "reauthentication_needed") {
      const { error: sendError } = await supabase.auth.reauthenticate();
      setSaving(false);
      if (sendError) {
        setError(sendError.message);
        return;
      }
      setNeedsCode(true);
      return;
    }

    setSaving(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setCode("");
    setNeedsCode(false);
    toast.success("Password updated");
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="space-y-1">
        <div className="text-title font-semibold">Password</div>
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
      </div>

      {needsCode ? (
        <div className="space-y-2">
          <Label htmlFor="reauth-code">Code from your email</Label>
          <Input
            id="reauth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            className="tracking-widest"
          />
          <p className="text-xs text-muted-foreground">
            You last signed in a while ago, so we emailed you a code to make sure it is you.
          </p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end border-t border-hairline pt-4">
        <Button onClick={save} disabled={saving || !ready}>
          {saving ? "Saving…" : "Update password"}
        </Button>
      </div>
    </SectionCard>
  );
}
