import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { TopBar } from "@/components/top-bar";
import { SubNav } from "@/components/sub-nav";
import { PageBody } from "@/components/page";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { SETTINGS_GROUPS } from "@/components/settings/settings-pages";
import { privacyLink, termsLink } from "@/lib/legal";
import { LegalAnchor } from "@/components/legal-anchor";

/**
 * Settings is a page in the shell (DESIGN.md §6, A9): the top bar says
 * "Settings", a 220px sub-nav lists the workspace's pages, yours and help,
 * and the page sits at 800px — 880 for the pages built around a table. It
 * used to be a card over the app that Escape closed; a page is somewhere you
 * can stay, link to, and come back to.
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

/** The pages drawn at 880px rather than 800 — each has a table or a list of rows. */
const WIDE = [
  "/settings/integrations",
  "/settings/usage",
  "/settings/coverage",
  "/settings/api-keys",
  "/settings/export",
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const groups = SETTINGS_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.map((i) =>
      i.action === "feedback" ? { ...i, onSelect: () => setFeedbackOpen(true) } : i,
    ),
  }));

  return (
    <>
      <TopBar title="Settings" />
      <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:min-h-[calc(100dvh-3rem)] lg:flex-row">
        <SubNav groups={groups} label="Settings pages" />
        <div className="min-w-0 flex-1">
          <PageBody width={WIDE.includes(pathname) ? "settings-wide" : "settings"}>
            <Outlet />
            {/* Both documents were reachable from exactly one place — the "I
                agree" checkbox on the sign-up form — so the moment somebody
                had an account they had no way back to what they had agreed
                to. Settings is where a reader looks. New tab: nobody should
                lose a workspace to read a policy. */}
            <p className="mt-16 border-t border-hairline pt-6 text-meta text-muted-foreground">
              <LegalAnchor link={termsLink()} newTab>
                Terms
              </LegalAnchor>
              <span aria-hidden> · </span>
              <LegalAnchor link={privacyLink()} newTab>
                Privacy Policy
              </LegalAnchor>
            </p>
          </PageBody>
        </div>
      </div>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} path={pathname} />
    </>
  );
}
