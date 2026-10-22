import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Disclosure } from "@/components/section-card";
import { ModelCost, ModelCostScale } from "@/components/model-cost";
import { modelTiers, priceFor, tierOf, type ReplyPrices } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";

/**
 * The model, as three words and a list.
 *
 * Fast / Standard / Best are the choice (`MODEL_TIERS`), the full list of
 * ids sits under "All models" for anyone who wants one, and an agent on a
 * model that is no tier shows as Custom with its id, so a value the three
 * chips cannot stand for is never drawn as nothing.
 *
 * On an install that serves none of the tier models — self-hosted, OpenAI
 * only — this is exactly the Select it replaced, so nothing there changes.
 *
 * The selected tier is the filled ink chip, as the template chips beside it in
 * the create dialog are: amber marks state that is live in the product, not a
 * transient UI selection. The chips are a radio group and work from the
 * keyboard, which DESIGN.md §8 asks of every control.
 */
export function ModelTierPicker({
  value,
  onChange,
  models,
  prices,
}: {
  value: string;
  onChange: (model: string) => void;
  /** What the list offers — `modelsFor(me.models, value)`. */
  models: string[];
  /** What each costs per reply, in the unit the server answers in — `replyPricesOf(me)`. */
  prices: ReplyPrices | undefined;
}) {
  const tiers = modelTiers(models);
  const list = (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m} value={m}>
            <span className="flex w-full items-center justify-between">
              <span>{m}</span>
              <ModelCost price={priceFor(prices, m)} />
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (tiers.length === 0) {
    return (
      <div className="space-y-2">
        {list}
        <ModelCostScale price={priceFor(prices, value)} />
      </div>
    );
  }

  const custom = tierOf(value) === null;
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Model" className="grid gap-1.5 sm:grid-cols-3">
        {tiers.map((t) => {
          const selected = t.model === value;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(t.model)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-200",
                selected
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border bg-surface hover:bg-surface-hover",
              )}
            >
              <span className="text-sm font-medium">{t.label}</span>
              <span
                className={cn(
                  "text-meta",
                  selected ? "text-primary-foreground/80" : "text-muted-foreground",
                )}
              >
                {t.description}
              </span>
            </button>
          );
        })}
        {custom && (
          // Not a button: there is nothing to press, it is the state the three
          // above cannot stand for, with the id that says what it is.
          <div
            role="radio"
            aria-checked="true"
            aria-disabled="true"
            className="flex flex-col items-start gap-0.5 rounded-md border border-transparent bg-primary px-3 py-2 text-primary-foreground sm:col-span-3"
          >
            <span className="text-sm font-medium">Custom</span>
            <span className="font-mono text-meta text-primary-foreground/80">{value}</span>
          </div>
        )}
      </div>
      <Disclosure label="All models">
        <div className="pt-1">{list}</div>
      </Disclosure>
      <ModelCostScale price={priceFor(prices, value)} />
    </div>
  );
}
