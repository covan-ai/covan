import { COST_BANDS, costBandIndex, formatReplyCost } from "@/lib/agent-meta";

/**
 * The price beside a model's name in a picker.
 *
 * Money rather than a rating out of five. A rating is what you show when all
 * you have is opaque credits; Covan has the providers' list prices, and a
 * number somebody can multiply by their own traffic is worth more than a tier
 * they have to learn. `lib/pricing.ts` on the server computes it, so this and
 * the usage screen are reading one price list.
 *
 * Nothing is rendered when there is no price. Under a custom endpoint every id
 * is unknown by design, and a blank is the honest shape of that.
 */
export function ModelCost({ cost }: { cost: number | null }) {
  if (cost === null) return null;
  return (
    <span className="ml-3 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
      {formatReplyCost(cost)}
    </span>
  );
}

/**
 * One scale under the Select, for the model that is currently picked.
 *
 * One, not thirteen. A five-square meter on every row is 65 marks in a
 * dropdown, which is noise before it is information — and if the marks were
 * amber it would be thirteen times over DESIGN.md's "about five amber elements
 * in a viewport". So the rows carry the money and this carries the shape of it.
 *
 * No amber here either: the bands are drawn in ink, because amber in this
 * system points at the thing you are in, and the Select above already does
 * that. A wide amber band would also be well past the 44px ceiling the same
 * rule sets.
 *
 * The sentence is not decoration. A number with no stated assumption is the
 * kind of claim this design system's first failure mode is about — somebody
 * whose agent reads forty-page documents should be able to tell at a glance
 * that this is not their number.
 */
export function ModelCostScale({ cost }: { cost: number | null }) {
  const active = costBandIndex(cost);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {COST_BANDS.map((band, i) => (
            <div
              key={band.label}
              className={`h-1 flex-1 rounded-full ${
                i === active ? "bg-foreground" : "bg-hairline"
              }`}
            />
          ))}
        </div>
        {cost !== null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {formatReplyCost(cost)} / reply
          </span>
        )}
      </div>

      <div className="flex gap-1" aria-hidden>
        {COST_BANDS.map((band, i) => (
          <span
            key={band.label}
            className={`flex-1 text-[10px] ${
              i === active ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {band.label}
          </span>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {cost === null
          ? "No price for this model — a custom endpoint serves whatever the operator configured, and its rates are theirs."
          : "Estimated from the average reply measured on this deployment: a 2,248-token prompt and a 921-token answer, priced as a fresh prompt. Longer conversations and larger documents cost more."}
      </p>
    </div>
  );
}
