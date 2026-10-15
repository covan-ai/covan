import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatFileSize } from "@/lib/file-size";

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
          subtitle="Bundles are folders. A new one is yours alone until you share it with the workspace."
        >
          <DocsLink page="knowledge">How retrieval picks a passage</DocsLink>
        </PageHeader>

        <KnowledgeUsage />

        <div className="mt-8">
          <KnowledgeExplorer />
        </div>
      </PageContainer>
    </AppShell>
  );
}

/**
 * How much there is, in one line, and where deleted things went.
 *
 * Counted by the caller's own policies, so it is what *you* can see — a
 * colleague's private bundles are not in it. Recently deleted lives in
 * workspace settings, which nobody looking at their files would think to open.
 */
function KnowledgeUsage() {
  const usage = useQuery({
    // Under "bundles", so every change that refreshes the bundle list — an
    // upload, a new bundle, a delete — refreshes these counts with it.
    queryKey: ["bundles", "usage"],
    queryFn: () => api.knowledge.usage(),
  });
  const u = usage.data;
  return (
    <p className="mt-4 text-meta text-muted-foreground">
      {u ? (
        <>
          {u.documents} {u.documents === 1 ? "file" : "files"} in {u.bundles}{" "}
          {u.bundles === 1 ? "bundle" : "bundles"} · {formatFileSize(u.bytes)} ·{" "}
          {u.passages.toLocaleString("en")} searchable passages ·{" "}
        </>
      ) : null}
      <Link
        to="/settings/workspace"
        hash="recently-deleted"
        className="underline hover:text-foreground"
      >
        Recently deleted
      </Link>
    </p>
  );
}
