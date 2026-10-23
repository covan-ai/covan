import { useTranslation } from "@/i18n";
import { RevealedSecret } from "@/components/revealed-secret";
import { useRoutineEventSetup } from "@/hooks/use-routines";

/**
 * The address an `email.received` routine is mailed at, on its own page.
 *
 * Not behind a button like a GitHub secret: the address is meant to be handed
 * out, and what keeps strangers from running the routine is the approved
 * senders list, not the address being hard to find. It stays on the page for
 * the same reason the webhook does — somebody setting up a forwarding rule
 * next month needs it again.
 */
export function EmailAddressSetup({
  routineId,
  senders,
}: {
  routineId: string;
  senders: string | null;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useRoutineEventSetup(routineId, true);

  if (isPending)
    return <p className="text-meta text-muted-foreground">{t("Loading the address…")}</p>;
  if (isError) {
    return (
      <p className="text-meta text-muted-foreground">
        {t("Couldn't load the address. Reload to try again.")}
      </p>
    );
  }
  if (data.kind !== "email") return null;

  return (
    <div className="space-y-3 rounded-lg border border-hairline p-4">
      <p className="text-sm">{t("This routine's address")}</p>
      <RevealedSecret value={data.address} label={t("Copy address")} />
      <p className="text-meta text-muted-foreground">
        {senders
          ? t("Mail from {{senders}} starts it. Anything else is ignored.", { senders })
          : t("Mail from the members of this workspace starts it. Anything else is ignored.")}{" "}
        {t("Forward a message here, or set up a rule that does.")}
      </p>
    </div>
  );
}
