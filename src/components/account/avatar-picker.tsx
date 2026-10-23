import { useRef } from "react";
import { useTranslation } from "@/i18n";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";

/**
 * Your photo, and the two things you can do to it. Each writes on its own,
 * without the form's Save: a picked photo is a decision already made, and
 * holding it in a pending state the rest of the form could discard would be
 * one more thing to explain.
 */
export function AvatarPicker({
  name,
  url,
  busy,
  onUpload,
  onRemove,
}: {
  name: string | null | undefined;
  url: string | null | undefined;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);

  // A16: the photo at 48px, then Upload photo and Remove.
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Avatar name={name} url={url} size={48} />
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? t("Saving…") : url ? t("Change photo") : t("Upload photo")}
      </Button>
      {url ? (
        <Button type="button" variant="ghost" disabled={busy} onClick={onRemove}>
          {t("Remove")}
        </Button>
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label={t("Photo")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again still fires a change.
          e.target.value = "";
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}
