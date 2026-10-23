import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { AgentMark } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { CreditsWall } from "@/components/credits-wall";
import { HBarList } from "@/components/hbar-list";
import { SectionLabel } from "@/components/section";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  api,
  ApiError,
  type BillingInvoice,
  type BillingSettings,
  type BillingSettingsPatch,
  type UsageMonthByAgent,
} from "@/lib/api-client";
import { approximateReplies, useCredits, wholeCredits, type CreditsView } from "@/lib/credits";
import { cn } from "@/lib/utils";

const n = (v: number, locale: string) => Math.round(v).toLocaleString(locale);

/**
 * Settings › Usage and billing, the hosted half (A15): what is left and what
 * this month has used, the switches around buying more, this month by agent
 * and the invoices. The ledger follows it (`credit-ledger.tsx`).
 *
 * Credits belong to the workspace — one balance every member spends from —
 * so every member sees the balance. What it went on, by agent and by entry,
 * is an admin's (0032, 0124); the reads behind it refuse anybody else, and
 * the sections are not drawn for them.
 */
export function UsageSection({ isAdmin }: { isAdmin: boolean }) {
  const credits = useCredits();
  const { data: month } = useQuery({
    queryKey: ["usage", "month"],
    queryFn: api.usageMonth,
    enabled: isAdmin,
  });
  const { data: billing } = useQuery({
    queryKey: ["billing", "settings"],
    queryFn: api.billing.settings,
  });
  const { data: invoices } = useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: api.billing.invoices,
    enabled: isAdmin,
  });

  const thisMonth = month?.available && month.unit === "credits" ? month : null;
  const settings = billing?.available ? billing : null;

  return (
    <>
      {credits && (
        <div
          className={cn(
            "mt-6 grid gap-4",
            settings && "md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]",
          )}
        >
          <BalanceCard
            credits={credits}
            spentThisMonth={thisMonth?.spent ?? null}
            byAgent={isAdmin}
          />
          {settings && <BillingCard settings={settings} isAdmin={isAdmin} />}
        </div>
      )}

      {credits?.level === "spent" && <CreditsWall />}

      {isAdmin && (thisMonth || invoices?.available) && (
        <div
          className={cn(
            "mt-10 grid gap-x-10 gap-y-8",
            thisMonth && invoices?.available && "md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]",
          )}
        >
          {thisMonth && <MonthByAgent month={thisMonth} />}
          {invoices?.available && <Invoices invoices={invoices.invoices} />}
        </div>
      )}
    </>
  );
}

function BalanceCard({
  credits,
  spentThisMonth,
  byAgent,
}: {
  credits: CreditsView;
  spentThisMonth: number | null;
  byAgent: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  // The bar is what is used of what there was: this month's spend against
  // it plus what is left where the month is known, everything ever added
  // otherwise.
  const used = spentThisMonth ?? Math.max(0, credits.granted - credits.balance);
  const whole = used + credits.balance;
  const share = whole > 0 ? used / whole : 0;
  const left =
    credits.balance > 0 && credits.balance < 1 ? "<1" : n(wholeCredits(credits.balance), locale);

  return (
    <div className="rounded-xl border border-border px-[22px] py-5">
      <div className="text-xs font-medium uppercase tracking-[0.06em] text-micro-foreground">
        {t("Credits left")}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{left}</div>
      <div className="mt-4 h-1.5 rounded-[3px] bg-border" aria-hidden>
        <div
          className="h-1.5 rounded-[3px] bg-foreground"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-meta text-muted-foreground">
        <span>
          {spentThisMonth !== null
            ? t("{{used}} used this month", { used: n(used, locale) })
            : t("{{used}} used of {{granted}} added", {
                used: n(used, locale),
                granted: n(credits.granted, locale),
              })}
        </span>
        {credits.level === "spent" ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot state="waiting" /> {t("Out of credits, new replies are paused")}
          </span>
        ) : credits.level === "low" ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot state="waiting" /> {t("Running low")}
          </span>
        ) : credits.repliesKnown ? (
          <span>
            {t("About {{replies}} reply left", {
              count: approximateReplies(credits.repliesLeft),
              replies: n(approximateReplies(credits.repliesLeft), locale),
              defaultValue_other: "About {{replies}} replies left",
            })}
          </span>
        ) : null}
      </div>
      {byAgent && (
        <div className="mt-[18px] flex gap-2">
          <Button variant="secondary" asChild>
            <a href="#by-agent">{t("Usage by agent")}</a>
          </Button>
        </div>
      )}
    </div>
  );
}

function BillingCard({ settings, isAdmin }: { settings: BillingSettings; isAdmin: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (patch: BillingSettingsPatch) => {
    setSaving(true);
    try {
      const next = await api.billing.updateSettings(patch);
      queryClient.setQueryData(["billing", "settings"], next);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("Couldn't save that"));
    } finally {
      setSaving(false);
    }
  };
  const { autoTopUp, lowBalance, card } = settings;

  return (
    <fieldset
      disabled={!isAdmin || saving}
      className="flex min-w-0 flex-col gap-3.5 rounded-xl border border-border px-[22px] py-5"
    >
      <SwitchRow
        label={t("Auto top-up")}
        checked={autoTopUp.available && autoTopUp.enabled}
        disabled={!autoTopUp.available}
        onChange={(on) => void save({ autoTopUp: { enabled: on } })}
        note={!autoTopUp.available ? <Chip size="sm">{t("Coming soon")}</Chip> : null}
      >
        {t(
          "Buys {{amount}} credits when the balance drops below {{below}}, with the card on file. Owners get an email each time.",
          { amount: n(autoTopUp.amount, locale), below: n(autoTopUp.below, locale) },
        )}
      </SwitchRow>
      <SwitchRow
        label={t("Low balance warning")}
        checked={lowBalance.enabled}
        onChange={(on) => void save({ lowBalance: { enabled: on } })}
      >
        {t(
          "Tell everyone in the workspace at {{below}} credits. Agents pause at zero; nothing is lost.",
          { below: n(lowBalance.below, locale) },
        )}
      </SwitchRow>
      <div className="border-t border-hairline pt-3 text-meta text-muted-foreground">
        {card
          ? t("Card ending {{last4}}", { last4: card.last4 })
          : t("No card on file yet — one is kept after a purchase.")}
      </div>
    </fieldset>
  );
}

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
  note,
  children,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        aria-label={label}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          {label}
          {note}
        </div>
        <div className="mt-0.5 text-meta text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function MonthByAgent({ month }: { month: UsageMonthByAgent }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <section id="by-agent" className="scroll-mt-20">
      <SectionLabel>{t("This month by agent")}</SectionLabel>
      {month.byAgent.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nothing spent since the 1st.")}</p>
      ) : (
        <HBarList
          label={t("Credits this month by agent")}
          rows={month.byAgent.map((a) => ({
            key: a.agentId,
            lead: <AgentMark agent={a} size={20} />,
            label: a.name,
            value: a.amount,
            display: n(a.amount, locale),
          }))}
        />
      )}
      <p className="mt-2 text-meta text-muted-foreground">
        {t("Replies and routine runs since the 1st, priced from what each model was paid.")}
      </p>
    </section>
  );
}

const STATUS_WORD: Record<BillingInvoice["status"], string> = {
  paid: msg("Paid"),
  refunded: msg("Refunded"),
  pending: msg("Pending"),
};

function Invoices({ invoices }: { invoices: BillingInvoice[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (id: string) => {
    setOpening(id);
    try {
      const { url } = await api.billing.invoicePdfUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("Couldn't open that invoice"));
    } finally {
      setOpening(null);
    }
  };

  return (
    <section>
      <SectionLabel>{t("Invoices")}</SectionLabel>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No purchases yet.")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex min-h-11 items-center gap-3 border-b border-hairline text-sm last:border-b-0"
            >
              <span className="font-medium">
                {new Date(inv.at).toLocaleDateString(locale, { month: "long", year: "numeric" })}
              </span>
              <span className="text-muted-foreground">
                {[
                  t("{{credits}} credit", {
                    count: Math.round(inv.credits),
                    credits: n(inv.credits, locale),
                    defaultValue_other: "{{credits}} credits",
                  }),
                  inv.total,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Chip>{lookup(t, STATUS_WORD[inv.status])}</Chip>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={opening === inv.id}
                onClick={() => void open(inv.id)}
              >
                {opening === inv.id ? t("Opening…") : t("Download PDF")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
