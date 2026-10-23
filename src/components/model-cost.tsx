import {
  COST_BANDS,
  costBandIndex,
  formatReplyCost,
  formatReplyCredits,
  formatReplyPrice,
  type ReplyPrice,
} from "@/lib/agent-meta";
import { Disclosure } from "@/components/disclosure";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";

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
  const { t } = useTranslation();
  const locale = useLocale();
  if (price === null) return null;
  return (
    <span className="ml-3 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
      {formatReplyPrice(price, t, locale)}
    </span>
  );
}
