import { Check, ChevronDown, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DIAL_EFFORTS,
  DIAL_EFFORT_HINTS,
  effortWord,
  type ReasoningEffort,
} from "@/lib/agent-meta";
import { cn } from "@/lib/utils";

/** "Off", "Brief", "Standard", "Extended", or "Auto" for the model's own. */
const word = (effort: ReasoningEffort | null) => (effort == null ? "Auto" : effortWord(effort));

/**
 * How long the next message is thought about (A2): "Thinking · Brief". Only
 * on a model that reasons — on one that does not, there is nothing to set.
 * Auto is the agent's own setting, or the model's when the agent has none.
 */
export function ThinkingChip({
  value,
  agentEffort,
  disabled = false,
  compact = false,
  onChange,
}: {
  /** In force for the next message; null is Auto. */
  value: ReasoningEffort | null;
  agentEffort: ReasoningEffort | null;
  disabled?: boolean;
  compact?: boolean;
  onChange: (effort: ReasoningEffort | null) => void;
}) {
  const item = (effort: ReasoningEffort | null, label: string, hint?: string) => (
    <DropdownMenuItem key={label} onSelect={() => onChange(effort)} className="gap-2.5">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Check
        aria-hidden
        className={cn("size-4 shrink-0", value === effort ? "opacity-100" : "opacity-0")}
      />
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Thinking: ${word(value)}`}
          className="h-7 gap-1.5 px-2 text-meta text-muted-foreground data-[state=open]:bg-surface"
        >
          <Lightbulb />
          {compact ? word(value) : `Thinking · ${word(value)}`}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64">
        <DropdownMenuLabel className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
          Thinking for this message
        </DropdownMenuLabel>
        {item(
          null,
          "Auto",
          agentEffort == null ? "The model's own" : `The agent's: ${word(agentEffort)}`,
        )}
        {item("minimal", "Off")}
        <DropdownMenuSeparator />
        {DIAL_EFFORTS.map((level) => item(level, effortWord(level), DIAL_EFFORT_HINTS[level]))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
