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
 */
export function WorkspaceStep({
  currentName,
  onDone,
}: {
  currentName: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
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
