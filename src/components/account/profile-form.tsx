import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Field } from "@/components/field";
import { AvatarPicker } from "@/components/account/avatar-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
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
import { browserTimeZone, listTimeZones, timeZoneLabel } from "@/lib/timezones";

export const BIO_MAX = 280;

/**
 * What the rest of the workspace knows about you: your name, your photo, a
 * line about what you do, and the clock you keep. The language is under
 * Preferences (A16).
 *
 * Seeded from `user` at mount and never again, and remounted by the caller's
 * `key` once `me` arrives, so a refetch never overwrites what is being typed.
 * Save sends only what changed, so
 * a field somebody else could not have touched is never written back with a
 * stale value.
 */
export function ProfileForm({ user }: { user: Me["user"] | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [timezone, setTimezone] = useState<string | null>(user?.timezone ?? null);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [zonesOpen, setZonesOpen] = useState(false);

  const patch = useMemo(() => {
    if (!user) return {};
    const next: ProfilePatch = {};
    if (name.trim() !== (user.name ?? "")) next.name = name.trim();
    if (bio.trim() !== (user.bio ?? "")) next.bio = bio.trim() || null;
    if (timezone !== (user.timezone ?? null)) next.timezone = timezone;
    return next;
  }, [user, name, bio, timezone]);

  const dirty = Object.keys(patch).length > 0;

  const discard = () => {
    setName(user?.name ?? "");
    setBio(user?.bio ?? "");
    setTimezone(user?.timezone ?? null);
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.profile.update(patch);
      toast.success(t("Profile saved"));
      // `me` feeds the sidebar and the member list too, so everything showing
      // you refreshes together rather than disagreeing until a reload.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Failed to save your profile"));
    } finally {
      setSaving(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    setPhotoBusy(true);
    try {
      const image = await resizeAvatar(file);
      await api.profile.uploadAvatar(image);
      toast.success(t("Photo saved"));
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("Failed to save the photo"),
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await api.profile.removeAvatar();
      toast.success(t("Photo removed"));
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Failed to remove the photo"));
    } finally {
      setPhotoBusy(false);
    }
  };

  const deviceZone = browserTimeZone();
  const pickZone = (zone: string | null) => {
    setTimezone(zone);
    setZonesOpen(false);
  };

  // A16's Profile as Field rows; Save and Discard under them.
  return (
    <>
      <Field
        label={t("Photo")}
        help={t("Your initials until you upload one. PNG, JPEG or WebP, cropped square.")}
      >
        <AvatarPicker
          name={user?.name}
          url={user?.avatarUrl}
          busy={photoBusy || !user}
          onUpload={uploadPhoto}
          onRemove={removePhoto}
        />
      </Field>

      <Field label={t("Name")} help={t("Shown next to the threads you start.")}>
        <Input
          id="profile-name"
          aria-label={t("Display name")}
          className="max-w-[420px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </Field>

      <Field label={t("About you")} help={t("What you work on, so a teammate knows who to ask.")}>
        <Textarea
          id="profile-bio"
          aria-label={t("About you")}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={BIO_MAX}
          rows={3}
          placeholder={t("Runs support for the EU stores.")}
        />
        <span className="mt-1 block text-right text-xs text-micro-foreground tabular-nums">
          {bio.length}/{BIO_MAX}
        </span>
      </Field>

      <Field label={t("Time zone")} help={t("Your greeting, dates and reminders follow it.")}>
        <Button
          id="profile-timezone"
          type="button"
          variant="secondary"
          aria-label={t("Time zone")}
          className="w-full max-w-[420px] justify-start font-normal"
          onClick={() => setZonesOpen(true)}
        >
          <span className="truncate">
            {timezone ? timeZoneLabel(timezone) : t("Follow the device")}
          </span>
        </Button>
      </Field>

      <div className="flex items-center justify-end gap-2 py-4">
        <span className="mr-auto text-xs text-muted-foreground">
          {t("Your name, photo and the line about you are seen by everyone in your workspaces.")}
        </span>
        {dirty ? (
          <Button variant="ghost" onClick={discard} disabled={saving}>
            {t("Discard")}
          </Button>
        ) : null}
        <Button onClick={save} disabled={saving || !dirty || !name.trim()}>
          {saving ? t("Saving…") : t("Save profile")}
        </Button>
      </div>

      <CommandDialog open={zonesOpen} onOpenChange={setZonesOpen}>
        <CommandInput placeholder={t("Search time zones…")} />
        <CommandList>
          <CommandEmpty>{t("No zone by that name.")}</CommandEmpty>
          <CommandGroup>
            {deviceZone ? (
              <CommandItem value={`device ${deviceZone}`} onSelect={() => pickZone(deviceZone)}>
                {t("Use this device’s zone ({{zone}})", { zone: timeZoneLabel(deviceZone) })}
              </CommandItem>
            ) : null}
            <CommandItem value="follow the device clear" onSelect={() => pickZone(null)}>
              {t("Follow the device")}
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading={t("All zones")}>
            {listTimeZones().map((zone) => (
              <CommandItem key={zone} value={zone} onSelect={() => pickZone(zone)}>
                {timeZoneLabel(zone)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
