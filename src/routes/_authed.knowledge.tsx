import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { DocsLink } from "@/components/docs-link";
import { KnowledgeExplorer } from "@/components/knowledge-explorer";
import { PageContainer, PageHeader } from "@/components/page-container";

export const Route = createFileRoute("/_authed/knowledge")({
  component: KnowledgePage,
  head: () => ({
    meta: [
      { title: "Knowledge — Covan" },
      { name: "description", content: "Every document your workspace has, in its bundles." },
    ],
  }),
});

/**
 * The workspace's files.
 *
 * A bundle belongs to the workspace and always has; only the screen for it was
 * an agent's. That was wrong in a way that showed: to look inside a bundle you
 * had to attach it to an agent first, so the answer to "what do we have written
 * down?" was reachable only by changing what an agent knows. This page asks the
 * question where it lives, and the agent's Knowledge tab keeps the question that
 * is genuinely about the agent — which of these does it read.
 */
function KnowledgePage() {
  return (
    <AppShell>
      <PageContainer width="dashboard">
        <PageHeader
          badge="Knowledge"
          title="Everything the team"
          turn="has written down."
          subtitle="Bundles are folders that belong to the workspace."
        >
          <DocsLink page="knowledge">How retrieval picks a passage</DocsLink>
        </PageHeader>

        <div className="mt-8">
          <KnowledgeExplorer />
        </div>
      </PageContainer>
    </AppShell>
  );
}
