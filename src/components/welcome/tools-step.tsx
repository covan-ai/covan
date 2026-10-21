import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { searchTools, type ToolEntry } from "@/lib/onboarding-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolLogo } from "@/components/integrations/tool-logo";
import { cn } from "@/lib/utils";

/**
 * Which tools the person uses: a searchable grid, as many as apply.
 *
 * Records intent and nothing else — no consent screen opens from here. The
 * first conversation offers to connect the first one named, and the setup
 * list after it keeps offering until something is connected.
 *
 * Checkbox semantics on every tile, because that is what this is: several
 * can be on. Space toggles; Enter makes sure the tile is on and submits, so
 * the keyboard can answer with one tool in two presses. The tick is the
 * system's checkbox mark, an ink square, not an amber one: amber is a pointer
 * here and the tiles are many.
 */
export function ToolsStep({
  formId,
  value,
  onSubmit,
  onValidityChange,
}: {
  formId: string;
  /** What was recorded before, for a reload of this screen. */
  value: string[] | null;
  onSubmit: (tools: string[]) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>(value ?? []);
  const [query, setQuery] = useState("");
  const [requesting, setRequesting] = useState(false);

  const valid = selected.length > 0;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const shown = searchTools(query);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit(selected);
  };

  const onTileKey = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!selected.includes(id)) {
        // Submit with it on. `setSelected` has not landed yet, so hand the
        // merged list straight to the parent rather than through the form.
        onSubmit([...selected, id]);
      } else {
        onSubmit(selected);
      }
    }
  };

  const request = async () => {
    const wanted = query.trim();
    if (!wanted) return;
    setRequesting(true);
    try {
      await api.feedback.send({
        kind: "idea",
        message: `Tool request from the first run: ${wanted}`,
        path: "/welcome",
      });
      toast.success(`Noted. We'll let you know about ${wanted}.`);
    } catch {
      toast.error("Couldn't send that. Try again in a moment.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-micro-foreground"
        />
        <Input
          aria-label="Search tools"
          placeholder="Search tools"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      {shown.length > 0 ? (
        <div
          role="group"
          aria-label="Tools you use"
          className="grid max-h-80 grid-cols-2 gap-2.5 overflow-y-auto p-0.5 sm:grid-cols-3"
        >
          {shown.map((tool) => (
            <ToolTile
              key={tool.id}
              tool={tool}
              on={selected.includes(tool.id)}
              onToggle={() => toggle(tool.id)}
              onKeyDown={(e) => onTileKey(e, tool.id)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="text-title font-semibold leading-tight">Couldn't find “{query.trim()}”</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-[1.45] text-muted-foreground">
            Tell us and we'll look into it. Or ask your assistant about it later — it can often
            reach a tool through one of these.
          </p>
          <div className="mt-5 flex justify-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void request()}
              disabled={requesting}
            >
              {requesting ? "Sending…" : "Request it"}
            </Button>
          </div>
        </div>
      )}

      {selected.length > 0 ? (
        <p className="text-meta text-muted-foreground" aria-live="polite">
          {selected.length === 1 ? "1 tool picked." : `${selected.length} tools picked.`} Your
          assistant starts with the first.
        </p>
      ) : null}
    </form>
  );
}

function ToolTile({
  tool,
  on,
  onToggle,
  onKeyDown,
}: {
  tool: ToolEntry;
  on: boolean;
  onToggle: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const unavailable = tool.connect.kind === "none";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex items-center gap-2.5 rounded-lg border py-3 pl-2.5 pr-7 text-left transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        on ? "border-border bg-surface" : "border-hairline bg-card hover:bg-surface-hover",
      )}
    >
      <ToolLogo tool={tool} size={28} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-tight [overflow-wrap:anywhere]">
          {tool.name}
        </span>
        {unavailable ? (
          <span className="text-xs leading-tight text-micro-foreground">{tool.line}</span>
        ) : null}
      </span>
      {on ? (
        <span
          aria-hidden
          className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-sm bg-primary text-primary-foreground"
        >
          <Check className="h-3 w-3" />
        </span>
      ) : null}
    </button>
  );
}
