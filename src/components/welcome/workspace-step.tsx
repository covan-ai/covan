import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

/**
 * The signup trigger named this workspace "<Name>'s Workspace" without asking.
 * This is the asking. Pre-filled, so continuing without touching it is a valid
 * answer and costs one click.
 *
 * `currentName` null means there is no workspace to rename: the account
 * signed up with an invitation waiting (0115) and did not take it, or the
 * invitation lapsed. Then this starts one, which is also where a hosted
 * account's free credits land.
 */
export function WorkspaceStep({
  currentName,
  onDone,
}: {
  currentName: string | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

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
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input
          id="workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder={currentName === null ? "Acme" : undefined}
          required
          autoFocus
        />
      </div>
      <Button type="submit" className="w-full" disabled={saving || !name.trim()}>
        {saving ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}
