import { useRef } from "react";
import { UserAvatar } from "@/components/avatars";
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
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-4">
      <UserAvatar name={name} url={url} className="h-16 w-16 text-xs" />
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Saving…" : url ? "Change photo" : "Upload photo"}
          </Button>
          {url ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPEG or WebP. Cropped to a square.</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Photo"
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
