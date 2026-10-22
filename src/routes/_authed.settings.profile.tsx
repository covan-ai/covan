import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { SectionTitle } from "@/components/section";
import { ProfileForm } from "@/components/account/profile-form";
import { EmailCard } from "@/components/account/email-card";
import { SignInMethods } from "@/components/account/sign-in-methods";

export const Route = createFileRoute("/_authed/settings/profile")({
  component: ProfileSettingsPage,
  head: () => ({
    meta: [
      { title: "Profile — Settings — Covan" },
      { name: "description", content: "Your name, photo and address in Covan." },
    ],
  }),
});

function ProfileSettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  return (
    <>
      <SectionTitle title="Profile" lede="Who you are across every workspace you belong to." />
      <div className="mt-5">
        {/* Keyed so the form is seeded once `me` arrives, and again only
            when the person changes. */}
        <ProfileForm key={me?.user.id ?? "pending"} user={me?.user} />
        {/* Keyed on the address so a confirmed change clears the "we sent a
            link" note along with the input. */}
        <EmailCard key={me?.user.email ?? "pending"} email={me?.user.email} />
        <SignInMethods />
      </div>
    </>
  );
}
