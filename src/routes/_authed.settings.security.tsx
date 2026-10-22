import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { PasswordCard } from "@/components/account/password-card";
import { TwoFactorCard } from "@/components/account/two-factor-card";

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
  return (
    <>
      <SectionTitle title="Security" lede="How you sign in, and what keeps it yours." />
      <section className="mt-8 flex flex-col gap-6">
        <PasswordCard />
        <TwoFactorCard />
      </section>
    </>
  );
}
