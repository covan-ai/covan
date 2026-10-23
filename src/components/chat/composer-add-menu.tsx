import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lookup, msg, useTranslation } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The composer's "+" (A2): what can go into a message besides words. Each
 * row is there only when its handler is — a viewer gets none of the writes,
 * and the menu is not drawn at all when it would be empty. Home's ask bar
 * has Attach alone.
 */
export function ComposerAddMenu({
  onAttach,
  onUpload,
  onReport,
  onDictate,
}: {
  onAttach?: () => void;
  onUpload?: () => void;
  onReport?: () => void;
  /** On a phone, where the mic has no room of its own. */
  onDictate?: () => void;
}) {
  const { t } = useTranslation();
  const items = [
    onAttach && { label: msg("Attach a file"), run: onAttach },
    onUpload && { label: msg("Upload to Knowledge"), run: onUpload },
    onReport && { label: msg("Write a report"), run: onReport },
    onDictate && { label: msg("Dictate"), run: onDictate },
  ].filter((i): i is { label: string; run: () => void } => Boolean(i));
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Add to this message")}
          className="text-muted-foreground data-[state=open]:bg-surface"
          data-coach="attach"
        >
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-52">
        {items.map((i) => (
          <DropdownMenuItem key={i.label} onSelect={i.run}>
            {lookup(t, i.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
