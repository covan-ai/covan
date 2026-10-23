import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Folder, FolderPlus, Globe, Blocks } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
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

/** "Research and Finance", "Research, Finance and Support" — in the reader's language. */
function listOf(names: string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}

/**
 * An agent's Knowledge tab (A32): which of the workspace's folders it reads —
 * a switch per folder, with how much each was used — what else it reaches,
 * the documents worth revisiting and how much of what it was asked nothing
 * written was close to. The files themselves are on the Knowledge page.
 */
export function AgentKnowledge({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const locale = useLocale();
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
    const parts = [
      t("{{count}} file", { count: documentCount, defaultValue_other: "{{count}} files" }),
    ];
    const source = (connections.data?.connections ?? []).find((c) => c.bundleId === bundleId);
    if (source)
      parts.push(
        t("synced from {{source}}", { source: SOURCE_NAME[source.provider] ?? source.provider }),
      );
    if ((routines.data ?? []).some((r) => r.outputBundleId === bundleId))
      parts.push(t("written by routines"));
    if (reads.has(bundleId)) {
      const replies = usage.data?.byBundle[bundleId]?.replies ?? 0;
      if (replies > 0)
        parts.push(
          t("used in {{count}} reply this month", {
            count: replies,
            defaultValue_other: "used in {{count}} replies this month",
          }),
        );
    } else {
      const others = agents
        .filter((a) => a.id !== agent.id && a.bundleIds.includes(bundleId))
        .map((a) => a.name);
      if (others.length > 0)
        parts.push(t("read by {{agents}}", { agents: listOf(others, locale) }));
    }
    return parts.join(" · ");
  };

  const connectedApp = t("connected app");
  const alsoReads = [
    ...(tools.data?.connections ?? [])
      .filter((c) => c.status === "active" && !(agent.connectionsOff ?? []).includes(c.id))
      .map((c) => ({
        key: c.id,
        icon: Blocks,
        name: c.label,
        note:
          c.transport === "composio"
            ? t("{{app}} · asks before its first action", { app: c.toolkitSlug ?? connectedApp })
            : c.transport === "http"
              ? t("an HTTP API")
              : t("a database"),
      })),
    ...(agent.webSearch
      ? [
          {
            key: "web",
            icon: Globe,
            name: t("The web, when asked"),
            note: t("web search on"),
          },
        ]
      : []),
    ...(!agent.browserOff
      ? [
          {
            key: "browser",
            icon: Globe,
            name: t("Pages in a browser"),
            note: t("asks before each task"),
          },
        ]
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
      const check = validateUpload(file, t);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      try {
        await uploadToBundle(firstRead.id, file);
        added += 1;
      } catch {
        toast.error(t("Couldn't upload {{file}}", { file: file.name }));
      }
    }
    if (added > 0)
      toast.success(
        t("Added {{count}} file to {{folder}}", {
          count: added,
          folder: firstRead.name,
          defaultValue_other: "Added {{count}} files to {{folder}}",
        }),
      );
  };

  return (
    <>
      <TopBarPortal>
        <Button variant="secondary" asChild>
          <Link to="/knowledge">{t("Open Knowledge")}</Link>
        </Button>
      </TopBarPortal>

      <PageBody width="wide" className="lg:pt-7">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <h2 className="m-0 text-xl font-semibold">
              {t("What {{agent}} reads", { agent: agent.name })}
            </h2>
            <p className="mt-1.5 mb-4 text-sm text-muted-foreground">
              {t(
                "Folders are shared by the whole workspace; this is only which of them {{agent}} looks at before it answers. It sees new files within a minute.",
                { agent: agent.name },
              )}
            </p>
            {bundles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("No folders yet. Make one, and {{agent}} can read it.", { agent: agent.name })}
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
                        aria-label={t("{{agent}} reads {{folder}}", {
                          agent: agent.name,
                          folder: b.name,
                        })}
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
                  <FolderPlus /> {t("New folder")}
                </Button>
                {firstRead ? (
                  <Button variant="ghost" onClick={() => uploadInput.current?.click()}>
                    {t("Upload to {{folder}}", { folder: firstRead.name })}
                  </Button>
                ) : null}
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  aria-label={
                    firstRead
                      ? t("Upload to {{folder}}", { folder: firstRead.name })
                      : t("Upload to a folder")
                  }
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : null}

            {alsoReads.length > 0 ? (
              <>
                <SectionLabel>{t("Also reads")}</SectionLabel>
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
                          {t("Tools")}
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
                  action={
                    isAdmin ? <Link to="/settings/coverage">{t("Coverage")}</Link> : undefined
                  }
                >
                  {t("Worth revisiting")}
                </SectionLabel>
                <p className="mt-0 mb-2 text-meta text-muted-foreground">
                  {t(
                    "Old enough to doubt, used enough to matter. Shown only on the days there is something.",
                  )}
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
                        {t("{{age}} · {{count}} reply", {
                          age: ageWords(d.createdAt, undefined, t),
                          count: d.uses,
                          defaultValue_other: "{{age}} · {{count}} replies",
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("Open {{name}}", { name: d.name })}
                        onClick={() => setOpened(d)}
                      >
                        {t("Open")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {grounding && answers > 0 ? (
              <>
                <SectionLabel className={documents.length === 0 ? "lg:mt-1" : undefined}>
                  {t("Asked, not covered")}
                </SectionLabel>
                <div
                  role="img"
                  aria-label={t(
                    "{{agent}}, last 30 days: {{covered}}% found a passage, {{fallback}}% fell back to whole documents, {{ungrounded}}% nothing close",
                    {
                      agent: agent.name,
                      covered: pct(grounding.covered),
                      fallback: pct(grounding.fallback),
                      ungrounded: pct(grounding.ungrounded),
                    },
                  )}
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
                  {isAdmin ? (
                    <Trans
                      t={t}
                      i18nKey="In the last 30 days, {{pct}}% of what {{agent}} was asked had no close passage in these folders. Adding the documents people keep asking about is the fix; the <coverage>Coverage</coverage> page shows which agents are in the same place."
                      values={{ pct: usage.data?.notCoveredPct ?? 0, agent: agent.name }}
                      components={{
                        coverage: (
                          <Link
                            to="/settings/coverage"
                            className="font-medium underline-offset-4 hover:underline"
                          />
                        ),
                      }}
                    />
                  ) : (
                    t(
                      "In the last 30 days, {{pct}}% of what {{agent}} was asked had no close passage in these folders. Adding the documents people keep asking about is the fix.",
                      { pct: usage.data?.notCoveredPct ?? 0, agent: agent.name },
                    )
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
        title={t("New folder")}
        label={t("Name")}
        placeholder={t("Policies")}
        submitLabel={t("Create folder")}
        busyLabel={t("Creating…")}
        onSubmit={async (name) => {
          try {
            const bundle = await createBundle(name.trim());
            await attachBundle(agent.id, bundle.id);
            toast.success(
              t("{{agent}} reads {{folder}}", { agent: agent.name, folder: bundle.name }),
            );
            return true;
          } catch {
            toast.error(t("Couldn't create that folder"));
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
