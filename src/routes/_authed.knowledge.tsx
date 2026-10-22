import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { formatFileSize } from "@/lib/file-size";

import { DocsLink } from "@/components/docs-link";
import { KnowledgeExplorer } from "@/components/knowledge-explorer";
import { PageContainer } from "@/components/page-container";

export const Route = createFileRoute("/_authed/knowledge")({
  component: KnowledgePage,
  head: () => ({
    meta: [
      { title: "Knowledge — Covan" },
      { name: "description", content: "Every document your workspace has, in its folders." },
    ],
  }),
});

/**
 * The workspace's files, as a file manager.
 *
 * A folder belongs to the workspace and always has; only the screen for it was
 * an agent's. That was wrong in a way that showed: to look inside a folder you
 * had to attach it to an agent first, so the answer to "what do we have written
 * down?" was reachable only by changing what an agent knows. This page asks the
 * question where it lives, and the agent's Knowledge tab keeps the question that
 * is genuinely about the agent — which of these does it read.
 *
 * No heading over the window. The explorer's toolbar already says where you
 * are, and a title and a lede above a thing that is itself a window made the
 * page two things — a document about the files, and the files. The usage line
 * that stood under the lede is the window's status line now.
 */
function KnowledgePage() {
  return (
    <>
      <PageContainer width="dashboard" className="py-6">
        <h1 className="sr-only">Knowledge</h1>
        <KnowledgeExplorer
          className="lg:h-[calc(100vh-3rem)] lg:min-h-[480px]"
          footer={<KnowledgeUsage />}
        />
      </PageContainer>
    </>
  );
}

/**
 * How much there is, in one line, and where deleted things went.
 *
 * Counted by the caller's own policies, so it is what *you* can see — a
 * colleague's private folders are not in it. Recently deleted lives in
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
    <>
      {u ? (
        <>
          {u.documents} {u.documents === 1 ? "file" : "files"} in {u.bundles}{" "}
          {u.bundles === 1 ? "folder" : "folders"} · {formatFileSize(u.bytes)} ·{" "}
          {u.passages.toLocaleString("en")} searchable passages ·{" "}
        </>
      ) : null}
      <Link
        to="/settings/workspace"
        hash="recently-deleted"
        className="underline underline-offset-2 hover:text-foreground"
      >
        Recently deleted
      </Link>
      {" · "}
      <DocsLink page="knowledge">How retrieval picks a passage</DocsLink>
    </>
  );
}
