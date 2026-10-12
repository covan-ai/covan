import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, SectionHeading } from "@/components/page-container";
import { SettingsPage } from "@/components/settings/settings-page";
import { ProfileForm } from "@/components/settings/profile-form";
import { PersonalPreferencesSection } from "@/components/preferences-section";
import { DeliveryChannelsCard } from "@/components/routines/delivery-channels-card";
import { ApiKeysSection } from "@/components/api-keys-section";
import { BrowserSignInsSection } from "@/components/browser-signins-section";
import { CloseAccountSection } from "@/components/close-account-section";
import { api } from "@/lib/api-client";

export const Route = createFileRoute("/_authed/settings/account")({
  component: AccountSettingsPage,
  head: () => ({
    meta: [
      { title: "Account settings — Covan" },
      { name: "description", content: "Your profile, preferences and account in Covan." },
    ],
  }),
});

/**
 * Everything on this page belongs to the person reading it, and to nobody
 * else in the workspace: a teammate cannot see it, an admin cannot change it,
 * and none of it moves when you switch workspaces.
 */
function AccountSettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  return (
    <SettingsPage>
      <PageHeader badge="Settings" title="Your account," turn="and only yours." />

      <section className="mt-14">
        <SectionHeading title="Profile" />
        {/* `key` is the seeding — see `ProfileForm`. */}
        <ProfileForm key={me?.user.id ?? "pending"} user={me?.user} />
      </section>

      <PersonalPreferencesSection me={me} />

      {/* A delivery channel belongs to a person — every policy on it is
          `user_id = auth.uid()` — so it sits here, beside the switches that
          send through it, and not with the workspace. */}
      <DeliveryChannelsCard />

      {/* Not gated on a role: a key can do only what its holder can, so a
          viewer holding one is a viewer, and there is nothing an admin needs
          to approve. The section hides itself where the deployment cannot
          honour a key at all. */}
      <ApiKeysSection />

      {/* Above the account section, because it is the cheap version of the
          same request: a person who wants Covan to stop holding a login
          should find that before they find the door that also takes their
          conversations with it. Each of its parts — the jar, the open
          browsers, the saved logins — renders nothing when it has nothing
          to show. */}
      <BrowserSignInsSection />

      {/* Last on the page, under everything it would destroy. Not gated on a
          role: erasure is the caller's own right and an admin has no say in
          it — the only thing that can refuse is a workspace that would be
          left without an admin, and the server says so by name. The way to
          take your work with you first is on the workspace page. */}
      <CloseAccountSection email={me?.user.email} />
    </SettingsPage>
  );
}
