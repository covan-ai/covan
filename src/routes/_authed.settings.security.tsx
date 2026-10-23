import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "@/i18n";
import { SectionTitle } from "@/components/section";
import { PasswordCard } from "@/components/account/password-card";
import { TwoFactorCard } from "@/components/account/two-factor-card";
import { SessionsList } from "@/components/account/sessions-list";

export const Route = createFileRoute("/_authed/settings/security")({
  component: SecuritySettingsPage,
  head: () => ({
    meta: [
      { title: "Security — Settings — Covan" },
      { name: "description", content: "Your password and two-step sign-in in Covan." },
    ],
  }),
});

function SecuritySettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <SectionTitle title={t("Security")} lede={t("How you sign in, and what keeps it yours.")} />
      <div className="mt-5">
        <PasswordCard />
        <TwoFactorCard />
        <SessionsList />
      </div>
    </>
  );
}
