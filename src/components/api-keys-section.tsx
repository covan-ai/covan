import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound } from "lucide-react";
import { SectionHeading } from "@/components/page-container";
import { SectionCard, DataRow, EmptyState } from "@/components/section-card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DocsLink } from "@/components/docs-link";
import { api, ApiError, type ApiKey } from "@/lib/api-client";
import { formatRelative } from "@/lib/relative-time";
import { toast } from "sonner";

/**
 * Keys for the REST API.
 *
 * A key acts as **you**, which is the sentence the whole section is built
 * around: there are no scopes to choose and no permissions to get wrong,
 * because a key can do exactly what its owner can and every policy it meets
 * says so. The corollary is the one people are surprised by, so it is written
 * on the screen rather than left in a migration — leave the workspace and your
 * keys stop working with you.
 *
 * Rendered only where the API can honour one. `available: false` is a
 * deployment without `SUPABASE_JWT_SECRET`, where offering a create button
 * would mint a credential nothing would accept.
 */
export function ApiKeysSection() {
  const [creating, setCreating] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["api-keys"],
    queryFn: api.apiKeys.list,
  });

  if (isLoading) return null;

  // A failure is not the same as "this deployment does not do that", and the
  // first version of this component treated them alike — one `!data?.available`
  // covered both, so when the API answered 500 the section rendered nothing and
  // the feature looked unshipped rather than broken. It took a probe against
  // production to find out otherwise. Whatever went wrong, say that something
  // did.
  if (isError) {
    return (
      <section className="mt-16">
        <SectionHeading title="API keys" />
        <SectionCard className="mt-6">
          <p className="text-sm text-muted-foreground">
            Couldn't load your keys. This is a fault rather than a setting — try again, and tell
            whoever runs this deployment if it persists.
          </p>
        </SectionCard>
      </section>
    );
  }

  if (!data?.available) return null;

  return (
    <section className="mt-16">
      <SectionHeading
        title="API keys"
        description="For scripts and scheduled jobs. A key does exactly what you can do — no more, and no less."
      />

      <SectionCard padded={false} className="mt-6 overflow-hidden">
        {data.keys.length === 0 ? (
          <EmptyState
            title="No keys yet"
            description="Create one to reach the API from somewhere that cannot sign in."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {data.keys.map((key) => (
              <li key={key.id}>
                <KeyRow apiKey={key} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Keys are yours, not the workspace's — leave this workspace and they stop working the
            same moment your own access does.
          </p>
          <DocsLink page="api">What the API accepts</DocsLink>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          New key
        </Button>
      </div>

      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState(false);

  const revoke = async () => {
    setRevoking(true);
    try {
      await api.apiKeys.revoke(apiKey.id);
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.success("Key revoked");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke that key");
      setRevoking(false);
    }
  };

  return (
    <DataRow
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-surface">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
        </span>
      }
      title={apiKey.name}
      meta={
        <>
          <span className="font-mono">{apiKey.prefix}…</span>
          {" · "}
          {/* Never used reads as a fact; "last used —" reads as missing data. */}
          {apiKey.lastUsedAt ? `last used ${formatRelative(apiKey.lastUsedAt)}` : "never used"}
        </>
      }
      trailing={
        <Button variant="ghost" size="sm" onClick={revoke} disabled={revoking} className="shrink-0">
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      }
    />
  );
}

/**
 * Create, then show the key exactly once.
 *
 * One dialog in two states rather than two dialogs: the second state is the
 * result of the first, and a key that appears in a window the person did not
 * expect is a key they close without reading. Nothing stores the plaintext, so
 * there is no screen anywhere that can show it again — which is why closing is
 * deliberately a button that says so.
 */
function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setName("");
      setCreated(null);
    }
  };

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const key = await api.apiKeys.create(name.trim());
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setCreated(key.token);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create that key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{created ? "Your new key" : "New API key"}</DialogTitle>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <RevealedKey token={created} />
            <p className="text-xs text-muted-foreground">
              This is the only time it is shown. Covan stores a hash of it, so nobody — including us
              — can show it to you again. If you lose it, revoke it and make another.
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => close(false)}>
                I've saved it
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label className="text-xs" htmlFor="api-key-name">
                What is it for
              </Label>
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly report script"
                maxLength={60}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Only for you to recognise it later — a key you cannot place is a key nobody dares
                revoke.
              </p>
            </div>

            <div className="mt-4 flex justify-end">
              <Button onClick={submit} disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create key"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevealedKey({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(token).then(
      () => {
        setCopied(true);
        // Long enough to be seen, short enough that the button goes back to
        // being one — a permanently ticked button stops looking pressable.
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast.error("Couldn't copy — your browser blocked it."),
    );
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface p-3">
      {/* `break-all`, not truncation: a key you can only see half of is a key
          you cannot check you pasted correctly. */}
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{token}</code>
      <Button variant="ghost" size="sm" onClick={copy} className="shrink-0">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">Copy key</span>
      </Button>
    </div>
  );
}
