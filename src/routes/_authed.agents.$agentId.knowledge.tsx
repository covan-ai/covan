import { createFileRoute, Link } from "@tanstack/react-router";

import { useAgentsStore } from "@/lib/agents-store";
import { PageContainer, PageHeader } from "@/components/page-container";
import { FirstUploads } from "@/components/first-uploads";
import { DocsLink } from "@/components/docs-link";
import { KnowledgeTemplates } from "@/components/knowledge-templates";
import { KnowledgeExplorer } from "@/components/knowledge-explorer";
import { RevisitPanel } from "@/components/revisit-panel";

export const Route = createFileRoute("/_authed/agents/$agentId/knowledge")({
  component: KnowledgeTab,
});

/**
 * What this agent reads, and the files themselves.
 *
 * The same explorer the workspace page mounts, handed the agent — which adds
 * two things and changes nothing else: the rail splits into attached and not
 * attached with the switch that moves a bundle between them, and it opens on
 * the one folder only an agent has, every document in every bundle attached to
 * it.
 *
 * One component rather than two screens that both list files. The old tab had a
 * bundle dropdown, a drop zone that appeared once a bundle was chosen, and a
 * flat list of every attached document with no way to tell which bundle a file
 * was in or to look inside a bundle that was not attached.
 */
function KnowledgeTab() {
  const { agentId } = Route.useParams();
  const { agents, bundles, canWrite } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId)!;

  return (
    <PageContainer width="dashboard">
      <PageHeader
        badge="Knowledge"
        title="Upload once."
        turn="Every agent can read it."
        subtitle="Switch a bundle on here and this agent can read it — the same bundle can back every other agent too."
      >
        <DocsLink page="knowledge">How retrieval picks a passage</DocsLink>
      </PageHeader>

      {/* Above the explorer rather than inside it. "Which of our documents is
          quietly wrong in the most places" is not a question about the folder
          you have open, and sorting the file list by staleness would move a
          document somebody is looking for. */}
      <RevisitPanel documents={agent.documents} className="mt-8" />

      {bundles.length === 0 && canWrite ? (
        <FirstUploads className="mt-6" />
      ) : (
        <div className="mt-6">
          <KnowledgeExplorer agent={agent} />
        </div>
      )}

      {/* For the account with nothing to upload yet. Only where uploading is
          possible: offering a viewer a form to fill in and then refusing the
          upload is worse than not offering it. */}
      {canWrite ? <KnowledgeTemplates openByDefault={agent.documents.length === 0} /> : null}

      <p className="mt-8 text-meta text-muted-foreground">
        Every bundle in the workspace, including the ones no agent reads, is on the{" "}
        <Link to="/knowledge" className="underline hover:text-foreground">
          Knowledge page
        </Link>
        .
      </p>
    </PageContainer>
  );
}
