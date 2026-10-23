import { useState } from "react";
import { Check, ChevronDown, ChevronLeft, Cpu } from "lucide-react";
import { Chip } from "@/components/chip";
import { ModelCost } from "@/components/model-cost";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelLabel, modelTiers, priceFor, type ReplyPrices } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { lookup, useTranslation } from "@/i18n";

/**
 * The model the next message is answered on (A2). Fast, Standard and Best
 * with the id each stands for and what a reply costs; the agent's own model
 * marked "Agent default", on its own row when it is no tier; "All models…"
 * for every id this install serves. It applies to the message being written
 * and nothing after it — the agent's default is its Configuration's.
 */
export function ModelChip({
  value,
  agentModel,
  models,
  prices,
  disabled = false,
  compact = false,
  onChange,
}: {
  /** The model the next message goes to. */
  value: string;
  agentModel: string;
  /** What this install serves: `modelsFor(me.models, agent.model)`. */
  models: string[];
  prices: ReplyPrices | undefined;
  /** A reply is running: the next message is not being written yet. */
  disabled?: boolean;
  /** A phone: the chip keeps its icon and drops its word. */
  compact?: boolean;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const tiers = modelTiers(models);
  const tiered = new Set<string>(tiers.map((tier) => tier.model));
  const label = modelLabel(value, t);

  const row = (model: string, name: string, id: string | null) => (
    <DropdownMenuItem key={model} onSelect={() => onChange(model)} className="gap-2.5">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">
          <span className="font-medium">{name}</span>
          {id && <span className="ml-1.5 text-xs text-muted-foreground">{id}</span>}
        </span>
        {model === agentModel && (
          <Chip size="sm" className="shrink-0">
            {t("Agent default")}
          </Chip>
        )}
      </span>
      <ModelCost price={priceFor(prices, model)} />
      <Check
        aria-hidden
        className={cn("size-4 shrink-0", model === value ? "opacity-100" : "opacity-0")}
      />
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu onOpenChange={(open) => !open && setAll(false)}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("Model: {{label}}", { label })}
          className="h-7 gap-1.5 px-2 text-meta text-foreground data-[state=open]:bg-surface"
        >
          <Cpu className="text-muted-foreground" />
          {!compact && <span className="max-w-[10rem] truncate">{label}</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-[300px]">
        {all ? (
          <>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setAll(false);
              }}
              className="text-meta text-muted-foreground"
            >
              <ChevronLeft /> {t("All models")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="max-h-72 overflow-y-auto">{models.map((m) => row(m, m, null))}</div>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
              {t("Model for this message")}
            </DropdownMenuLabel>
            {tiers.map((tier) => row(tier.model, lookup(t, tier.label), tier.model))}
            {!tiered.has(agentModel) && (
              <>
                {tiers.length > 0 && <DropdownMenuSeparator />}
                {row(agentModel, agentModel, null)}
              </>
            )}
            {models.some((m) => !tiered.has(m) && m !== agentModel) && (
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setAll(true);
                }}
                className="text-meta text-muted-foreground"
              >
                {t("All models…")}
              </DropdownMenuItem>
            )}
            <p className="m-0 px-2 pt-2 pb-1 text-xs leading-[1.4] text-micro-foreground">
              {t("Applies to this message. Change the agent’s default in Configuration.")}
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
