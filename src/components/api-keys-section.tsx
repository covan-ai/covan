import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { SectionLabel, SectionTitle } from "@/components/section";
import { StatusDot } from "@/components/status-dot";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DocsLink } from "@/components/docs-link";
import { api, ApiError, type ApiKey } from "@/lib/api-client";
import { lastActivityLabel } from "@/lib/day-groups";
import { toast } from "sonner";
import { RevealedSecret } from "@/components/revealed-secret";

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
 * Settings › API keys (A26): "New key" in the title, the key shown once in
 * an ink-bordered box, then the keys as a table. `available: false` is a
 * deployment without `SUPABASE_JWT_SECRET`, where a create button would mint
 * a credential nothing would accept.
 */
export function ApiKeysSection() {
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["api-keys"],
    queryFn: api.apiKeys.list,
  });

  const title = (
    <SectionTitle
      title="API keys"
      lede="A key acts as you. It can do exactly what you can and nothing more, so there are no scopes to get wrong. Leave the workspace and your keys stop with you."
      action={
        data?.available ? (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New key
          </Button>
        ) : undefined
      }
    />
  );

  if (isLoading) return title;

  // A failure is not the same as "this deployment does not do that", and the
  // first version of this component treated them alike — one `!data?.available`
  // covered both, so when the API answered 500 the section rendered nothing and
  // the feature looked unshipped rather than broken. Whatever went wrong, say
  // that something did.
  if (isError) {
    return (
      <>
        {title}
        <p className="mt-6 text-sm text-muted-foreground">
          Couldn't load your keys. This is a fault rather than a setting — try again, and tell
          whoever runs this deployment if it persists.
        </p>
      </>
    );
  }

  // A deployment without SUPABASE_JWT_SECRET: a create button would mint a
  // credential nothing accepts, so say there is none instead.
  if (!data?.available) {
    return (
      <>
        {title}
        <p className="mt-6 text-sm text-muted-foreground">
          This deployment does not issue keys. Whoever runs it can turn them on in its settings.
        </p>
      </>
    );
  }

  return (
    <>
      {title}

      {/* The key, once (A26): an ink-bordered box with the waiting ring,
          because nothing anywhere can show it again. */}
      {revealed && (
        <div className="mt-6 flex items-start gap-3.5 rounded-xl border border-foreground p-4">
          <StatusDot state="waiting" className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Your new key, &ldquo;{revealed.name}&rdquo;</div>
            <p className="mt-0.5 mb-2.5 text-meta text-muted-foreground">
              Copy it now. This is the only time it is shown; the server keeps a hash, not the key.
            </p>
            <RevealedSecret value={revealed.token} label="Copy key" inline>
              <Button variant="ghost" size="sm" onClick={() => setRevealed(null)}>
                I have saved it
              </Button>
            </RevealedSecret>
          </div>
        </div>
      )}

      <SectionLabel action={<DocsLink page="api">API reference</DocsLink>}>
        Keys · {data.keys.length}
      </SectionLabel>
      {data.keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No keys yet. Create one to reach the API from somewhere that cannot sign in.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            label="API keys"
            rows={data.keys}
            rowKey={(k) => k.id}
            columns={[
              {
                key: "name",
                header: "Name",
                cell: (k) => <span className="font-medium">{k.name}</span>,
              },
              {
                key: "key",
                header: "Key",
                cell: (k) => (
                  <span className="font-mono text-meta text-muted-foreground">{k.prefix}…</span>
                ),
              },
              {
                key: "created",
                header: "Created",
                hideBelow: "md",
                cell: (k) => (
                  <span className="text-muted-foreground">{lastActivityLabel(k.createdAt)}</span>
                ),
              },
              {
                key: "used",
                header: "Last used",
                // Never used reads as a fact; "last used —" reads as missing data.
                cell: (k) => (
                  <span className="text-muted-foreground">
                    {k.lastUsedAt ? lastActivityLabel(k.lastUsedAt) : "Never"}
                  </span>
                ),
              },
              {
                key: "revoke",
                header: <span className="sr-only">Revoke</span>,
                className: "w-20 text-right",
                cell: (k) => <RevokeKey apiKey={k} />,
              },
            ]}
          />
        </div>
      )}
      <p className="mt-3 text-meta text-muted-foreground">
        Keys belong to people, not to the workspace: a teammate&rsquo;s keys are on their page. A
        revoked key fails on the next request.
      </p>

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(name, token) => setRevealed({ name, token })}
      />
    </>
  );
}

function RevokeKey({ apiKey }: { apiKey: ApiKey }) {
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
    <Button
      variant="ghost"
      size="sm"
      onClick={revoke}
      disabled={revoking}
      className="text-destructive"
      aria-label={`Revoke ${apiKey.name}`}
    >
      {revoking ? "Revoking…" : "Revoke"}
    </Button>
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
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (name: string, token: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) setName("");
  };

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const key = await api.apiKeys.create(name.trim());
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      onCreated(name.trim(), key.token);
      close(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create that key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-1.5">
          <Label htmlFor="api-key-name">What is it for</Label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly report script"
            maxLength={60}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <p className="text-xs text-muted-foreground">Only for you to recognise it later.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !name.trim()}>
            {saving ? "Creating…" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
