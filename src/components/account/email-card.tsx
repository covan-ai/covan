import { useState } from "react";
import { SectionCard } from "@/components/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase/client";
import { rememberPendingEmail } from "@/lib/pending-email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Changing the address you sign in with.
 *
 * Supabase Auth owns the address, not this app: the change is asked of it
 * directly, and it sends a link to both the old address and the new one
 * (`double_confirm_changes`). Nothing changes until both are clicked, and
 * `profiles.email` follows on its own once the second one is — a trigger on
 * `auth.users` writes it, and the column is no longer anybody else's to
 * write. Both links land on `/confirmed`, which is already on every
 * deployment's redirect allow-list.
 */
export function EmailCard({ email }: { email: string | null | undefined }) {
  const [next, setNext] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = next.trim();
  const valid = EMAIL_RE.test(trimmed) && trimmed.toLowerCase() !== (email ?? "").toLowerCase();

  const send = async () => {
    if (!valid) return;
    setSending(true);
    setError(null);
    const { error: authError } = await supabase.auth.updateUser(
      { email: trimmed },
      { emailRedirectTo: `${window.location.origin}/confirmed` },
    );
    setSending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    rememberPendingEmail(trimmed);
    setSentTo(trimmed);
    setNext("");
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="space-y-1">
        <div className="font-dm text-title font-medium">Email address</div>
        <p className="text-meta text-muted-foreground">
          You sign in with <span className="text-foreground">{email ?? "…"}</span>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-email">New address</Label>
        <Input
          id="new-email"
          type="email"
          autoComplete="email"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setError(null);
          }}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {sentTo ? (
          <p className="text-xs text-muted-foreground" role="status">
            We sent a link to {email ?? "your current address"} and to {sentTo}. Click both; the
            change happens after the second.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            We send a link to both addresses, and nothing changes until both are clicked.
          </p>
        )}
      </div>

      <div className="flex justify-end border-t border-hairline pt-4">
        <Button onClick={send} disabled={sending || !valid}>
          {sending ? "Sending…" : "Change address"}
        </Button>
      </div>
    </SectionCard>
  );
}
