import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/section-card";
import { AvatarPicker } from "@/components/account/avatar-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { api, ApiError, type Me, type ProfilePatch } from "@/lib/api-client";
import { resizeAvatar } from "@/lib/avatar-resize";
import { LOCALES } from "@/lib/locales";
import { browserTimeZone, listTimeZones, timeZoneLabel } from "@/lib/timezones";

export const BIO_MAX = 280;

/** Stands for "follow the browser" in a picker, which cannot hold an empty value. */
const FOLLOW_BROWSER = "__browser__";

/**
 * What the rest of the workspace knows about you: your name, your photo, a
 * line about what you do, and the clock you keep.
 *
 * Seeded from `user` at mount and never again, and remounted by the caller's
 * `key` — the rule `WorkspaceForm` explains. Save sends only what changed, so
 * a field somebody else could not have touched is never written back with a
 * stale value.
 */
export function ProfileForm({ user }: { user: Me["user"] | undefined }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [locale, setLocale] = useState<string | null>(user?.locale ?? null);
  const [timezone, setTimezone] = useState<string | null>(user?.timezone ?? null);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [zonesOpen, setZonesOpen] = useState(false);

  const patch = useMemo(() => {
    if (!user) return {};
    const next: ProfilePatch = {};
    if (name.trim() !== (user.name ?? "")) next.name = name.trim();
    if (bio.trim() !== (user.bio ?? "")) next.bio = bio.trim() || null;
    if (locale !== (user.locale ?? null)) next.locale = locale;
    if (timezone !== (user.timezone ?? null)) next.timezone = timezone;
    return next;
  }, [user, name, bio, locale, timezone]);

  const dirty = Object.keys(patch).length > 0;

  const discard = () => {
    setName(user?.name ?? "");
    setBio(user?.bio ?? "");
    setLocale(user?.locale ?? null);
    setTimezone(user?.timezone ?? null);
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.profile.update(patch);
      toast.success("Profile saved");
      // `me` feeds the sidebar and the member list too, so everything showing
      // you refreshes together rather than disagreeing until a reload.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save your profile");
    } finally {
      setSaving(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    setPhotoBusy(true);
    try {
      const image = await resizeAvatar(file);
      await api.profile.uploadAvatar(image);
      toast.success("Photo saved");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(
        err instanceof ApiError || err instanceof Error ? err.message : "Failed to save the photo",
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await api.profile.removeAvatar();
      toast.success("Photo removed");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove the photo");
    } finally {
      setPhotoBusy(false);
    }
  };

  const deviceZone = browserTimeZone();
  const pickZone = (zone: string | null) => {
    setTimezone(zone);
    setZonesOpen(false);
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <AvatarPicker
        name={user?.name}
        url={user?.avatarUrl}
        busy={photoBusy || !user}
        onUpload={uploadPhoto}
        onRemove={removePhoto}
      />

      <div className="space-y-2 border-t border-hairline pt-5">
        <Label htmlFor="profile-name">Display name</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        <p className="text-xs text-muted-foreground">What the rest of the workspace sees.</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor="profile-bio">About you</Label>
          <span className="text-meta tabular-nums text-muted-foreground">
            {bio.length}/{BIO_MAX}
          </span>
        </div>
        <Textarea
          id="profile-bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={BIO_MAX}
          rows={3}
          placeholder="What you work on, so a teammate knows who to ask."
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="profile-locale">Language</Label>
          <Select
            value={locale ?? FOLLOW_BROWSER}
            onValueChange={(v) => setLocale(v === FOLLOW_BROWSER ? null : v)}
          >
            <SelectTrigger id="profile-locale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_BROWSER}>Follow the browser</SelectItem>
              {LOCALES.map((l) => (
                <SelectItem key={l.tag} value={l.tag}>
                  {l.label}
                </SelectItem>
              ))}
              {/* A tag set elsewhere (the API takes any BCP 47 tag) still
                  shows as itself rather than as a blank trigger. */}
              {locale && !LOCALES.some((l) => l.tag === locale) ? (
                <SelectItem value={locale}>{locale}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="profile-timezone">Time zone</Label>
          <Button
            id="profile-timezone"
            type="button"
            variant="outline"
            className="w-full justify-start font-normal"
            onClick={() => setZonesOpen(true)}
          >
            <span className="truncate">
              {timezone ? timeZoneLabel(timezone) : "Follow the device"}
            </span>
          </Button>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Your name, photo and the line about you are visible to everyone in your workspaces.
      </p>

      <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
        {dirty ? (
          <Button variant="ghost" onClick={discard} disabled={saving}>
            Discard
          </Button>
        ) : null}
        <Button onClick={save} disabled={saving || !dirty || !name.trim()}>
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </div>

      <CommandDialog open={zonesOpen} onOpenChange={setZonesOpen}>
        <CommandInput placeholder="Search time zones…" />
        <CommandList>
          <CommandEmpty>No zone by that name.</CommandEmpty>
          <CommandGroup>
            {deviceZone ? (
              <CommandItem value={`device ${deviceZone}`} onSelect={() => pickZone(deviceZone)}>
                Use this device&rsquo;s zone ({timeZoneLabel(deviceZone)})
              </CommandItem>
            ) : null}
            <CommandItem value="follow the device clear" onSelect={() => pickZone(null)}>
              Follow the device
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="All zones">
            {listTimeZones().map((zone) => (
              <CommandItem key={zone} value={zone} onSelect={() => pickZone(zone)}>
                {timeZoneLabel(zone)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </SectionCard>
  );
}
