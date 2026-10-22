import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { UsageSection } from "@/components/usage-section";
import { WorkspaceUsageSection } from "@/components/workspace-usage-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: UsageSettingsPage,
  head: () => ({
    meta: [
      { title: "Usage — Covan" },
      { name: "description", content: "What your Covan workspace has used, and what is left." },
    ],
  }),
});

/**
 * Your own figures and the workspace's, on one page and in that order, because
 * the two answer the same question at different scopes and reading one without
 * the other is how "Yours alone" got mistaken for the whole bill.
 */
function UsageSettingsPage() {
  const { isAdmin } = useWorkspaceRole();

  return (
    <>
      <SectionTitle
        title="Usage and billing"
        lede="What the answers have cost, and what is left."
      />

      <UsageSection />

      {/* Admin only: the functions behind it refuse anybody else anyway, so
          this is so the section is not there to be confused by. */}
      {isAdmin && <WorkspaceUsageSection />}
    </>
  );
}
