import { useState, type FormEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";

/**
 * One line of text, asked for in the app's own dialog.
 *
 * What `window.prompt` was doing for Rename and Add a web page. The browser's
 * box looked like an error from somewhere else, could not say what was wrong
 * with an answer, and blocks the whole page — an automated browser driving
 * the app had to be restarted to get past it.
 *
 * `onSubmit` answers whether to close: false keeps the dialog open with what
 * was typed, so a failed request (already toasted by the caller) can be
 * corrected rather than retyped.
 */
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  type?: "text" | "url";
  submitLabel: string;
  busyLabel: string;
  onSubmit: (value: string) => Promise<boolean>;
};

export function TextPromptDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(v) => !busy && props.onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        {/* Mounted with the content, so each opening starts from the current
            value rather than whatever was typed and abandoned last time. */}
        <PromptForm {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  onOpenChange,
  label,
  initialValue = "",
  placeholder,
  type = "text",
  submitLabel,
  busyLabel,
  onSubmit,
  busy,
  setBusy,
}: Props & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(trimmed)) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs" htmlFor="text-prompt-value">
          {label}
        </Label>
        {/* Never `type="url"`: the browser would refuse "example.com" with
            its own message before the caller could add the https:// it
            lacks. The keyboard is the part worth keeping. */}
        <Input
          id="text-prompt-value"
          type="text"
          inputMode={type === "url" ? "url" : undefined}
          value={value}
          autoFocus
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={busy || !trimmed}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
