import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { UserAvatar } from "@/components/avatars";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { api, ApiError, type Me } from "@/lib/api-client";

/** Your own display name. Same rule as `WorkspaceForm` (`workspace-form.tsx`), same reason. */
export function ProfileForm({ user }: { user: Me["user"] | undefined }) {
  const queryClient = useQueryClient();
  const [profileName, setProfileName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);

  const profileDirty = !!user && profileName.trim() !== (user.name ?? "");

  const handleSaveProfile = async () => {
    if (!profileName.trim()) return;
    setSavingProfile(true);
    try {
      await api.profile.update({ name: profileName.trim() });
      toast.success("Name saved");
      // `me` feeds the sidebar and the member list too, so everything showing
      // this name refreshes together rather than disagreeing until a reload.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save your name";
      toast.error(message);
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="flex items-center gap-4">
        <UserAvatar name={user?.name} url={user?.avatarUrl} className="h-11 w-11 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-meta text-muted-foreground">{user?.email ?? "…"}</div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name">Display name</Label>
        <Input
          id="profile-name"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          maxLength={80}
        />
        <p className="text-xs text-muted-foreground">What the rest of the workspace sees.</p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
        {profileDirty ? (
          <Button
            variant="ghost"
            onClick={() => setProfileName(user?.name ?? "")}
            disabled={savingProfile}
          >
            Discard
          </Button>
        ) : null}
        <Button
          onClick={handleSaveProfile}
          disabled={savingProfile || !profileDirty || !profileName.trim()}
        >
          {savingProfile ? "Saving…" : "Save name"}
        </Button>
      </div>

      <p className="border-t border-hairline pt-4 text-xs text-muted-foreground">
        Your photo still comes from the account you signed in with.
      </p>
    </SectionCard>
  );
}
