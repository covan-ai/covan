import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "@/i18n";
import { SectionTitle } from "@/components/section";
import { UsageSection } from "@/components/usage-section";
import { CreditLedger } from "@/components/credit-ledger";
import { WorkspaceUsageSection } from "@/components/workspace-usage-section";
import { useIsHosted } from "@/lib/credits";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: UsageSettingsPage,
  head: () => ({
    meta: [
      { title: "Usage and billing — Settings — Covan" },
      { name: "description", content: "What your Covan workspace has used, and what is left." },
    ],
  }),
});

/**
 * Settings › Usage and billing (A15). On the hosted service: the balance, the
 * switches around buying more, this month by agent, the invoices and the
 * ledger. On an install that charges nobody: one table by agent at list
 * prices, and nothing about credits.
 */
function UsageSettingsPage() {
  const { t } = useTranslation();
  const hosted = useIsHosted();
  const { isAdmin } = useWorkspaceRole();

  return (
    <>
      <SectionTitle
        title={t("Usage and billing")}
        lede={
          hosted === false
            ? t(
                "What the agents' replies cost at list prices. This install pays its providers directly, so nothing here is billed.",
              )
            : t(
                "Credits are the only unit: a reply, an indexed document, a connected-app call and a minute in the browser are all charged in them, from one balance the whole workspace shares.",
              )
        }
      />
      {hosted === true && (
        <>
          <UsageSection isAdmin={isAdmin} />
          {isAdmin && <CreditLedger />}
        </>
      )}
      {hosted === false && (
        <div className="mt-2">
          <WorkspaceUsageSection isAdmin={isAdmin} />
        </div>
      )}
    </>
  );
}
