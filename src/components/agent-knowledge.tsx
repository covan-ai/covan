import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Folder, FolderPlus, Globe, Blocks } from "lucide-react";
import { toast } from "sonner";
import { Chip } from "@/components/chip";
import { DocumentPreviewDialog } from "@/components/document-preview-dialog";
import { PageBody } from "@/components/page";
import { SectionLabel } from "@/components/section";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { TopBarPortal } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useConnections, useToolConnections } from "@/hooks/use-connections";
import { useRoutines } from "@/hooks/use-routines";
import { api, type RevisitDocument } from "@/lib/api-client";
import { canEditAgent } from "@/lib/agent-access";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { ageWords } from "@/lib/stale-documents";
import { ACCEPT, validateUpload } from "@/lib/uploads";
import { useWorkspaceRole } from "@/lib/workspace-role";

const SOURCE_NAME: Record<string, string> = { notion: "Notion", google_drive: "Google Drive" };

/** "Research and Finance", "Research, Finance and Support". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * An agent's Knowledge tab (A32): which of the workspace's folders it reads —
 * a switch per folder, with how much each was used — what else it reaches,
 * the documents worth revisiting and how much of what it was asked nothing
 * written was close to. The files themselves are on the Knowledge page.
 */
export function AgentKnowledge({ agent }: { agent: Agent }) {
  const { agents, bundles, attachBundle, detachBundle, createBundle, uploadToBundle } =
    useAgentsStore();
  const { isAdmin } = useWorkspaceRole();
  const canEdit = canEditAgent(agent);
  const usage = useQuery({
    queryKey: ["agent-knowledge-usage", agent.id],
    queryFn: () => api.agents.knowledgeUsage(agent.id, 30),
  });
  const revisit = useQuery({
    queryKey: ["coverage", "documents", 30, agent.id],
    queryFn: () => api.coverage.documents(30, agent.id),
  });
  const connections = useConnections();
  const tools = useToolConnections();
  const routines = useRoutines();
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<RevisitDocument | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const reads = new Set(agent.bundleIds);
  // Read first, then the rest, each group in the workspace's own order.
  const ordered = [...bundles].sort((a, b) => Number(reads.has(b.id)) - Number(reads.has(a.id)));
  const firstRead = bundles.find((b) => reads.has(b.id)) ?? null;

  const describe = (bundleId: string, documentCount: number): string => {
    const parts = [`${documentCount} ${documentCount === 1 ? "file" : "files"}`];
    const source = (connections.data?.connections ?? []).find((c) => c.bundleId === bundleId);
    if (source) parts.push(`synced from ${SOURCE_NAME[source.provider] ?? source.provider}`);
    if ((routines.data ?? []).some((r) => r.outputBundleId === bundleId))
      parts.push("written by routines");
    if (reads.has(bundleId)) {
      const replies = usage.data?.byBundle[bundleId]?.replies ?? 0;
      if (replies > 0)
        parts.push(`used in ${replies} ${replies === 1 ? "reply" : "replies"} this month`);
    } else {
      const others = agents
        .filter((a) => a.id !== agent.id && a.bundleIds.includes(bundleId))
        .map((a) => a.name);
      if (others.length > 0) parts.push(`read by ${listOf(others)}`);
    }
    return parts.join(" · ");
  };

  const alsoReads = [
    ...(tools.data?.connections ?? [])
      .filter((c) => c.status === "active" && !(agent.connectionsOff ?? []).includes(c.id))
      .map((c) => ({
        key: c.id,
        icon: Blocks,
        name: c.label,
        note:
          c.transport === "composio"
            ? `${c.toolkitSlug ?? "connected app"} · asks before its first action`
            : c.transport === "http"
              ? "an HTTP API"
              : "a database",
      })),
    ...(agent.webSearch
      ? [{ key: "web", icon: Globe, name: "The web, when asked", note: "web search on" }]
      : []),
    ...(!agent.browserOff
      ? [{ key: "browser", icon: Globe, name: "Pages in a browser", note: "asks before each task" }]
      : []),
  ];

  const grounding = usage.data?.grounding;
  const answers = usage.data?.answers ?? 0;
  const pct = (n: number) => (answers > 0 ? Math.round((n / answers) * 100) : 0);
  const documents = (revisit.data?.documents ?? []).slice(0, 3);

  const upload = async (files: FileList | null) => {
    if (!files || !firstRead) return;
    let added = 0;
    for (const file of Array.from(files)) {
      const check = validateUpload(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      try {
        await uploadToBundle(firstRead.id, file);
        added += 1;
      } catch {
        toast.error(`Couldn't upload ${file.name}`);
      }
    }
    if (added > 0)
      toast.success(`Added ${added} ${added === 1 ? "file" : "files"} to ${firstRead.name}`);
  };

  return (
    <>
      <TopBarPortal>
        <Button variant="secondary" asChild>
          <Link to="/knowledge">Open Knowledge</Link>
        </Button>
      </TopBarPortal>

      <PageBody width="home" className="lg:pt-7">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <h2 className="m-0 text-xl font-semibold">What {agent.name} reads</h2>
            <p className="mt-1.5 mb-4 text-sm text-muted-foreground">
              Folders are shared by the whole workspace; this is only which of them {agent.name}{" "}
              looks at before it answers. It sees new files within a minute.
            </p>
            {bundles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No folders yet. Make one, and {agent.name} can read it.
              </p>
            ) : (
              <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-border p-0">
                {ordered.map((b) => {
                  const on = reads.has(b.id);
                  return (
                    <li
                      key={b.id}
                      className="flex min-h-[52px] items-center gap-3 border-b border-hairline px-3.5 last:border-b-0"
                    >
                      <Folder
                        className={on ? "size-4 text-foreground" : "size-4 text-muted-foreground"}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 py-2">
                        <span
                          className={
                            on ? "block text-sm font-medium" : "block text-sm text-muted-foreground"
                          }
                        >
                          {b.name}
                        </span>
                        <span className="block truncate text-meta text-muted-foreground">
                          {describe(b.id, b.documentCount)}
                        </span>
                      </span>
                      <Switch
                        checked={on}
                        disabled={!canEdit}
                        aria-label={`${agent.name} reads ${b.name}`}
                        onCheckedChange={(next) => {
                          if (next) void attachBundle(agent.id, b.id);
                          else detachBundle(agent.id, b.id);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {canEdit ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  <FolderPlus /> New folder
                </Button>
                {firstRead ? (
                  <Button variant="ghost" onClick={() => uploadInput.current?.click()}>
                    Upload to {firstRead.name}
                  </Button>
                ) : null}
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  aria-label={`Upload to ${firstRead?.name ?? "a folder"}`}
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : null}

            {alsoReads.length > 0 ? (
              <>
                <SectionLabel>Also reads</SectionLabel>
                <ul className="m-0 list-none p-0">
                  {alsoReads.map((r) => (
                    <li
                      key={r.key}
                      className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-b-0"
                    >
                      <r.icon className="size-4 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {r.name}{" "}
                        <span className="font-normal text-muted-foreground">· {r.note}</span>
                      </span>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to="/agents/$agentId/configuration" params={{ agentId: agent.id }}>
                          Tools
                        </Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>

          <div>
            {documents.length > 0 ? (
              <>
                <SectionLabel
                  className="lg:mt-1"
                  action={isAdmin ? <Link to="/settings/coverage">Coverage</Link> : undefined}
                >
                  Worth revisiting
                </SectionLabel>
                <p className="mt-0 mb-2 text-meta text-muted-foreground">
                  Old enough to doubt, used enough to matter. Shown only on the days there is
                  something.
                </p>
                <ul className="m-0 list-none p-0">
                  {documents.map((d) => (
                    <li
                      key={d.documentId}
                      className="flex min-h-11 items-center gap-2.5 border-b border-hairline last:border-b-0"
                    >
                      <Chip tone="code" className="min-w-0 truncate">
                        {d.name}
                      </Chip>
                      <span className="flex-1 text-meta text-muted-foreground">
                        {ageWords(d.createdAt)} · {d.uses} {d.uses === 1 ? "reply" : "replies"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Open ${d.name}`}
                        onClick={() => setOpened(d)}
                      >
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {grounding && answers > 0 ? (
              <>
                <SectionLabel className={documents.length === 0 ? "lg:mt-1" : undefined}>
                  Asked, not covered
                </SectionLabel>
                <div
                  role="img"
                  aria-label={`${agent.name}, last 30 days: ${pct(grounding.covered)}% found a passage, ${pct(grounding.fallback)}% fell back to whole documents, ${pct(grounding.ungrounded)}% nothing close`}
                  className="mb-2 flex h-3.5 gap-0.5"
                >
                  {[
                    { n: grounding.covered, swatch: "bg-foreground" },
                    { n: grounding.fallback, swatch: "bg-foreground/50" },
                    { n: grounding.ungrounded, swatch: "bg-input" },
                  ]
                    .filter((s) => s.n > 0)
                    .map((s, i) => (
                      <i
                        key={i}
                        className={`block h-3.5 first:rounded-l-[4px] last:rounded-r-[4px] ${s.swatch}`}
                        style={{ width: `${pct(s.n)}%` }}
                      />
                    ))}
                </div>
                <p className="m-0 text-meta leading-[1.5] text-muted-foreground">
                  In the last 30 days, {usage.data?.notCoveredPct ?? 0}% of what {agent.name} was
                  asked had no close passage in these folders. Adding the documents people keep
                  asking about is the fix
                  {isAdmin ? (
                    <>
                      ; the{" "}
                      <Link
                        to="/settings/coverage"
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        Coverage
                      </Link>{" "}
                      page shows which agents are in the same place.
                    </>
                  ) : (
                    "."
                  )}
                </p>
              </>
            ) : null}
          </div>
        </div>
      </PageBody>

      <TextPromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="New folder"
        label="Name"
        placeholder="Policies"
        submitLabel="Create folder"
        busyLabel="Creating…"
        onSubmit={async (name) => {
          try {
            const bundle = await createBundle(name.trim());
            await attachBundle(agent.id, bundle.id);
            toast.success(`${agent.name} reads ${bundle.name}`);
            return true;
          } catch {
            toast.error("Couldn't create that folder");
            return false;
          }
        }}
      />
      {opened ? (
        <DocumentPreviewDialog
          documentId={opened.documentId}
          name={opened.name}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}
