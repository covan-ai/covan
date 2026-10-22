import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

/**
 * A workspace for an account that has none.
 *
 * The signup trigger gives every account a workspace, except one that signed
 * up with an invitation waiting (0115) — the invitation is its way in. If it
 * declines, or the invitation lapsed, this starts one, which is also where a
 * hosted account's free credits land.
 *
 * `currentName` is kept for the one other caller this used to have — renaming
 * the guessed workspace — and is null everywhere this is shown today. The
 * team step names a workspace that exists.
 */
export function WorkspaceStep({
  formId,
  currentName,
  suggestion,
  onDone,
  onValidityChange,
  onBusyChange,
}: {
  formId: string;
  currentName: string | null;
  /** What to start the field on: the name given at sign-up, when there was one. */
  suggestion?: string | null;
  onDone: () => void;
  onValidityChange?: (valid: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(suggestion ?? currentName ?? "");
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  useEffect(() => {
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;

    // Unchanged means nothing to write. Skipping the request keeps a no-op from
    // being able to fail.
    if (trimmed === currentName) {
      onDone();
      return;
    }

    setSaving(true);
    if (currentName === null) {
      try {
        await api.workspaces.create(trimmed);
        // Everything read so far was read with no workspace behind it.
        await queryClient.invalidateQueries();
        onDone();
      } catch {
        toast.error("Couldn't create the workspace.");
        setSaving(false);
      }
      return;
    }
    try {
      await api.workspace.update({ name: trimmed });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onDone();
    } catch {
      toast.error("Couldn't rename the workspace.");
      setSaving(false);
    }
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="Acme"
          className="max-w-[360px]"
          required
          autoFocus
        />
        <p className="m-0 text-meta text-muted-foreground">
          Your team sees it in the sidebar and in the invitations you send.
        </p>
      </div>
    </form>
  );
}
