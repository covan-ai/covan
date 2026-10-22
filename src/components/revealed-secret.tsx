import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * A secret shown exactly once, with the one button that matters next to it.
 *
 * Written for API keys and now used by webhook signing secrets too. The two
 * screens have the same job — the server cannot show this string again, so the
 * moment it is on screen is the only chance to keep it — and a second copy of
 * this would be a second place for the clipboard failure path to be forgotten.
 */
export function RevealedSecret({
  value,
  label,
  inline,
  children,
}: {
  value: string;
  label: string;
  /** A26's look: the secret in a mono box, then an ink "Copy" and whatever follows. */
  inline?: boolean;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        // Long enough to be seen, short enough that the button goes back to
        // being one — a permanently ticked button stops looking pressable.
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast.error("Couldn't copy — your browser blocked it."),
    );
  };

  if (inline) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded-md border border-input bg-surface-muted px-2.5 py-1.5 font-mono text-meta">
          {value}
        </code>
        <Button size="sm" onClick={copy} aria-label={label}>
          {copied ? "Copied" : "Copy"}
        </Button>
        {children}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface p-3">
      {/* `break-all`, not truncation: a secret you can only see half of is a
          secret you cannot check you pasted correctly. */}
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
      <Button variant="ghost" size="sm" onClick={copy} className="shrink-0">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">{label}</span>
      </Button>
    </div>
  );
}
