import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { PageContainer } from "@/components/page-container";
import { SettingsNav } from "@/components/settings/settings-nav";
import { privacyLink, termsLink } from "@/lib/legal";
import { LegalAnchor } from "@/components/legal-anchor";

/**
 * Settings was one long page that mixed what belongs to you (your name, your
 * keys, closing your account) with what belongs to the workspace (its name,
 * its default model, its trash). It is an area now: this route is the frame,
 * and each page under it is about one of the two.
 *
 * `/settings` itself has no page; `_authed.settings.index.tsx` sends it to
 * your account, which is where both entries in the sidebar's account menu used
 * to land.
 */
export const Route = createFileRoute("/_authed/settings")({
  component: SettingsLayout,
  head: () => ({
    meta: [
      { title: "Settings — Covan" },
      { name: "description", content: "Your account and your workspace's settings in Covan." },
    ],
  }),
});

function SettingsLayout() {
  return (
    <AppShell>
      <PageContainer width="dashboard">
        <div className="lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-12">
          <SettingsNav />
          <div className="min-w-0">
            <Outlet />
          </div>
        </div>

        {/* Both documents were reachable from exactly one place — the "I agree"
            checkbox on the sign-up form — so the moment somebody had an account
            they had no way back to what they had agreed to. Settings is where a
            reader looks, and it is what both entries in the sidebar's account
            menu lead to. New tab: nobody should lose a workspace to read a
            policy. In the frame rather than on one page, so every settings page
            has it. */}
        <p className="mt-16 border-t border-hairline pt-6 text-xs text-muted-foreground">
          <LegalAnchor link={termsLink()} newTab>
            Terms
          </LegalAnchor>{" "}
          ·{" "}
          <LegalAnchor link={privacyLink()} newTab>
            Privacy Policy
          </LegalAnchor>
        </p>
      </PageContainer>
    </AppShell>
  );
}
