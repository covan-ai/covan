import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { api, ApiError, type Workspace } from "@/lib/api-client";

/**
 * This form and `ProfileForm` are seeded from `me` at mount and never again. The
 * effects that used to do the seeding are gone (#68), and the identity of the
 * thing being edited — passed as `key` by the caller — is what discards a
 * half-typed edit. That is the whole rule, and it is the one
 * `agents.$agentId.settings.tsx` already followed.
 *
 * It matters here more than most places, because settings invalidates `me`
 * itself: saving your display name refetches it so the sidebar agrees, and the
 * workspace form's old effect depended on `me.workspace` — a fresh object on
 * every refetch. So saving one form wiped whatever you had typed in the other.
 * Keying on the id cannot make that mistake; there is nothing to re-run.
 *
 * The cost, stated plainly: a workspace renamed in another tab does not appear
 * in these inputs until something remounts them. An input you are typing in is
 * exactly where a background write should not land.
 */
export function WorkspaceForm({
  workspace,
  isAdmin,
}: {
  workspace: Workspace | undefined;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace?.name ?? "");
  const [slug, setSlug] = useState(workspace?.slug ?? "");
  const [saving, setSaving] = useState(false);

  const dirty = !!workspace && (name !== workspace.name || slug !== workspace.slug);

  const handleSave = async () => {
    if (!workspace || !name.trim() || !slug.trim()) return;
    setSaving(true);
    try {
      await api.workspace.update({ name, slug });
      toast.success("Changes saved");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save changes";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!workspace) return;
    setName(workspace.name);
    setSlug(workspace.slug);
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <fieldset disabled={!isAdmin} className="contents">
        <div className="space-y-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ws-slug">Slug</Label>
          <Input
            id="ws-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Short identifier used in links. Lowercase letters, numbers and dashes.
          </p>
        </div>
      </fieldset>
      {isAdmin ? (
        <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
          {dirty ? (
            <Button variant="ghost" onClick={reset} disabled={saving}>
              Discard
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={saving || !dirty || !name.trim() || !slug.trim()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}
