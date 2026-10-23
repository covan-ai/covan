import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { api } from "@/lib/api-client";
import { formatFileSize } from "@/lib/file-size";

import { DocsLink } from "@/components/docs-link";
import { KnowledgeExplorer } from "@/components/knowledge-explorer";

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
 * No heading over the window but the bar's own path ("Knowledge / Contracts"),
 * and a title and a lede above a thing that is itself a window would make the
 * page two things — a document about the files, and the files. The usage line
 * is the window's status line.
 */
function KnowledgePage() {
  // A window, not a document (A6): the bar, the folder column and the files
  // fill the screen under the shell, and only the files scroll.
  return (
    <div data-fill-screen className="flex min-h-0 flex-1 flex-col">
      <KnowledgeExplorer chrome="page" footer={<KnowledgeUsage />} />
    </div>
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
  const { t } = useTranslation();
  const locale = useLocale();
  const usage = useQuery({
    // Under "bundles", so every change that refreshes the bundle list — an
    // upload, a new bundle, a delete — refreshes these counts with it.
    queryKey: ["bundles", "usage"],
    queryFn: () => api.knowledge.usage(),
  });
  const u = usage.data;
  // Named before the sentence they go into: the extractor does not read a
  // `t()` nested in another's options.
  const files = u
    ? t("{{count}} file", { count: u.documents, defaultValue_other: "{{count}} files" })
    : "";
  const folders = u
    ? t("{{count}} folder", { count: u.bundles, defaultValue_other: "{{count}} folders" })
    : "";
  return (
    <>
      {u ? (
        <>
          {t("{{files}} in {{folders}} · {{size}} · {{passages}} searchable passages", {
            files,
            folders,
            size: formatFileSize(u.bytes, locale),
            passages: u.passages.toLocaleString(locale),
          })}
          {" · "}
        </>
      ) : null}
      <Link
        to="/settings/export"
        hash="recently-deleted"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {t("Recently deleted")}
      </Link>
      {" · "}
      <DocsLink page="knowledge">{t("How retrieval picks a passage")}</DocsLink>
    </>
  );
}
