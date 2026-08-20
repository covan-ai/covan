import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { UserAvatar } from "@/components/avatars";
import { DeliveryChannelsCard } from "@/components/routines/delivery-channels-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsPage,
  head: () => ({
    meta: [
      { title: "Settings — Covan" },
      { name: "description", content: "Workspace settings for your Covan team." },
    ],
  }),
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (me?.workspace) {
      setName(me.workspace.name);
      setSlug(me.workspace.slug);
    }
  }, [me?.workspace]);

  const dirty = !!me && (name !== me.workspace.name || slug !== me.workspace.slug);

  const handleSave = async () => {
    if (!me || !name.trim() || !slug.trim()) return;
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
    if (!me) return;
    setName(me.workspace.name);
    setSlug(me.workspace.slug);
  };

  return (
    <AppShell>
      <PageContainer width="form">
        <PageHeader badge="Settings" title="Names, and where" turn="the work gets sent." />

        <section className="mt-14">
          <SectionHeading title="Workspace" />
          <SectionCard className="mt-6 space-y-5">
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
            <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
              {dirty ? (
                <Button variant="ghost" onClick={reset} disabled={saving}>
                  Discard
                </Button>
              ) : null}
              <Button
                onClick={handleSave}
                disabled={saving || !dirty || !name.trim() || !slug.trim()}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </SectionCard>
        </section>

        <section className="mt-16">
          <SectionHeading title="Your account" />
          <SectionCard className="mt-6">
            <div className="flex items-center gap-4">
              <UserAvatar
                name={me?.user.name}
                url={me?.user.avatarUrl}
                className="h-11 w-11 text-xs"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium">{me?.user.name ?? "…"}</div>
                <div className="truncate text-[13px] text-muted-foreground">
                  {me?.user.email ?? "…"}
                </div>
              </div>
            </div>
            <p className="mt-4 border-t border-hairline pt-4 text-xs text-muted-foreground">
              Your name and photo come from the account you signed in with. Sign out from the menu
              at the bottom of the sidebar.
            </p>
          </SectionCard>
        </section>

        <DeliveryChannelsCard />
      </PageContainer>
    </AppShell>
  );
}
