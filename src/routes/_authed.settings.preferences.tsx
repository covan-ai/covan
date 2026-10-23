import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { api } from "@/lib/api-client";
import { SectionTitle } from "@/components/section";
import { PersonalPreferencesSection } from "@/components/preferences-section";
import { DeliveryChannelsCard } from "@/components/routines/delivery-channels-card";
import { CloseAccountSection } from "@/components/close-account-section";

export const Route = createFileRoute("/_authed/settings/preferences")({
  component: PreferencesSettingsPage,
  head: () => ({
    meta: [
      { title: "Preferences — Settings — Covan" },
      { name: "description", content: "How Covan looks and what it tells you about." },
    ],
  }),
});

function PreferencesSettingsPage() {
  const { t } = useTranslation();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  return (
    <>
      <SectionTitle
        title={t("Preferences")}
        lede={t("How Covan looks, and what it tells you about.")}
      />
      <div className="mt-5">
        <PersonalPreferencesSection me={me ?? undefined} />
        {/* Where routines deliver is a person's: a channel belongs to whoever
          set it up (0019), so it sits here beside the switches that send
          through it. */}
        <DeliveryChannelsCard />
        {/* Last: erasure is the caller's own right, and the way to take your
          work with you first is Export and deletion. */}
        <CloseAccountSection email={me?.user.email} />
      </div>
    </>
  );
}
