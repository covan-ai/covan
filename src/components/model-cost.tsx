import {
  COST_BANDS,
  costBandIndex,
  formatReplyCost,
  formatReplyCredits,
  formatReplyPrice,
  type ReplyPrice,
} from "@/lib/agent-meta";
import { Disclosure } from "@/components/disclosure";

/**
 * The price beside a model's name in a picker.
 *
 * Money rather than a rating out of five. A rating is what you show when all
 * you have is opaque credits; Covan has the providers' list prices, and a
 * number somebody can multiply by their own traffic is worth more than a tier
 * they have to learn. `lib/pricing.ts` on the server computes it, so this and
 * the usage screen are reading one price list.
 *
 * In credits on the hosted service and in dollars on an install that has no
 * credits: the unit comes with the figure (`ReplyPrice`), decided by the
 * server, so no screen converts and a person never meets both.
 *
 * Nothing is rendered when there is no price. Under a custom endpoint every id
 * is unknown by design, and a blank is the honest shape of that.
 */
export function ModelCost({ price }: { price: ReplyPrice | null }) {
  if (price === null) return null;
  return (
    <span className="ml-3 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
      {formatReplyPrice(price)}
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
 *
 * In credits there is no ruler. Its three edges are absolute amounts of money
 * (`COST_BANDS`), and labelling them in credits would need the credits-per-
 * dollar rate on the client — the one number the open tree keeps out of
 * reach (`boundary.test.ts`), and one that would go stale the day the markup
 * changed. The figure and its assumption carry the information.
 */
export function ModelCostScale({ price }: { price: ReplyPrice | null }) {
  if (price?.unit === "credits") {
    return (
      <div className="space-y-1.5">
        <span className="font-mono text-xs tabular-nums">
          {formatReplyCredits(price.amount)} / reply
        </span>
        <p className="text-xs text-muted-foreground">
          Estimated from the average reply measured on this deployment, at today&rsquo;s rate.
        </p>
        <Disclosure label="What that assumes">
          A 2,248-token prompt and a 921-token answer, priced as a fresh prompt. Longer
          conversations and larger documents cost more.
        </Disclosure>
      </div>
    );
  }

  const cost = price?.amount ?? null;
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
          <span className="shrink-0 font-mono text-xs tabular-nums">
            {formatReplyCost(cost)} / reply
          </span>
        )}
      </div>

      <div className="flex gap-1" aria-hidden>
        {COST_BANDS.map((band, i) => (
          <span
            key={band.label}
            className={`flex-1 text-xs ${
              i === active ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {band.label}
          </span>
        ))}
      </div>

      {cost === null ? (
        <p className="text-xs text-muted-foreground">
          No price for this model — a custom endpoint&rsquo;s rates are the operator&rsquo;s.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Estimated from the average reply measured on this deployment.
          </p>
          <Disclosure label="What that assumes">
            A 2,248-token prompt and a 921-token answer, priced as a fresh prompt. Longer
            conversations and larger documents cost more.
          </Disclosure>
        </>
      )}
    </div>
  );
}
