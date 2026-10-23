import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lookup, msg, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { Avatar } from "@/components/avatar";
import { Chip } from "@/components/chip";
import { DataTable } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { StatusWord } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { api, ApiError, type TrashItem, type TrashKind } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { formatRelative } from "@/lib/relative-time";
import { toast } from "sonner";

/**
 * What this workspace deleted and can still get back.
 *
 * Deleting used to be final and larger than it looked: an agent took every
 * session anybody had with it, every message in those, and every routine
 * pointed at it, because the foreign keys cascaded. Now it marks, and this is
 * the thirty-day window before the sweeper finishes the job.
 *
 * The list shows only deletions somebody actually performed. The documents that
 * went down with a bundle are not rows here — they were not separate decisions,
 * and restoring the bundle is what brings them back. That is `deleted_via` in
 * the schema and it is the reason a bundle of two hundred files does not arrive
 * here as two hundred and one things to think about.
 *
 * Not rendered for a viewer: `workspace_trash()` refuses them with a 403 rather
 * than an empty list, because an empty list would tell them there was nothing
 * to restore, which is a different claim and possibly a false one.
 */
export function RecentlyDeletedSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: () => api.trash.list(),
    enabled: canWrite,
  });

  if (!canWrite) return null;

  const items = data?.items ?? [];
  const days = data?.retentionDays ?? 30;

  const restore = async (item: TrashItem) => {
    if (restoring) return;
    setRestoring(item.id);
    try {
      await api.trash.restore(item.kind, item.id);
      // Everything on screen could have changed: an agent coming back brings
      // its conversations and routines with it, and a bundle brings its
      // documents. Refetching the workspace-scoped queries is what puts them
      // back on the screens that list them.
      await invalidateWorkspaceScoped(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      toast.success(t("{{name}} restored", { name: item.name }));
    } catch (e) {
      // The one message worth passing through verbatim: a document whose bundle
      // is also deleted cannot come back on its own, and the server says which
      // to press first.
      toast.error(e instanceof ApiError ? e.message : t("Couldn't restore that"));
    } finally {
      setRestoring(null);
    }
  };

  // Bundles and documents only: they own the stored files, and a file somebody
  // should never have uploaded is the reason to want this. Asked for in words,
  // because it is the one button here with no way back.
  const forget = async (item: TrashItem) => {
    if (restoring || (item.kind !== "bundle" && item.kind !== "document")) return;
    if (!confirm(t("Delete “{{name}}” for good? This cannot be undone.", { name: item.name })))
      return;
    setRestoring(item.id);
    try {
      await api.trash.forget(item.kind, item.id);
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      toast.success(t("{{name}} is gone for good", { name: item.name }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("Couldn't delete that"));
    } finally {
      setRestoring(null);
    }
  };

  // A27: a table — Item, Type, Deleted by, When, Days left, Restore — with
  // the last day marked by the ring.
  return (
    <section id="recently-deleted" className="scroll-mt-16">
      <SectionLabel
        action={
          <span className="font-normal">
            {t("{{count}} day, then gone for good", {
              count: days,
              defaultValue_other: "{{count}} days, then gone for good",
            })}
          </span>
        }
      >
        {t("Recently deleted")}
      </SectionLabel>
      <p className="mb-2 text-meta text-muted-foreground">
        {t(
          "Only deletions somebody performed are listed. Restoring an agent brings back every thread and routine that went with it.",
        )}
      </p>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          {t(
            "Nothing deleted. Agents, folders, documents, threads and routines wait here for {{count}} day before they go for good.",
            {
              count: days,
              defaultValue_other:
                "Nothing deleted. Agents, folders, documents, threads and routines wait here for {{count}} days before they go for good.",
            },
          )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <DataTable
            label={t("Recently deleted")}
            rows={items}
            rowKey={(item) => `${item.kind}:${item.id}`}
            columns={[
              {
                key: "item",
                header: t("Item"),
                cell: (item) => (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{item.name}</span>
                    {item.kind === "document" && item.parentName ? (
                      <span className="truncate text-muted-foreground">· {item.parentName}</span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: "kind",
                header: t("Type", { context: "kind", defaultValue: "Type" }),
                cell: (item) => <Chip>{lookup(t, KIND_WORD[item.kind])}</Chip>,
              },
              {
                key: "by",
                header: t("Deleted by"),
                hideBelow: "md",
                cell: (item) =>
                  item.deletedBy ? (
                    <span className="inline-flex items-center gap-2">
                      <Avatar name={item.deletedBy} size={20} />
                      {firstName(item.deletedBy)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("Someone no longer here")}</span>
                  ),
              },
              {
                key: "when",
                header: t("When"),
                hideBelow: "md",
                cell: (item) => (
                  <span className="text-muted-foreground">
                    {formatRelative(item.deletedAt, undefined, t, locale)}
                  </span>
                ),
              },
              {
                key: "left",
                header: t("Days left"),
                cell: (item) => {
                  const left = daysLeft(item.purgesAt, days);
                  return left <= 1 ? (
                    <StatusWord state="waiting">{Math.max(0, left)}</StatusWord>
                  ) : (
                    <span className="tabular-nums">{left}</span>
                  );
                },
              },
              {
                key: "actions",
                header: <span className="sr-only">{t("Actions")}</span>,
                className: "text-right",
                cell: (item) => (
                  <span className="inline-flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void restore(item)}
                      disabled={restoring === item.id}
                    >
                      {restoring === item.id ? t("Working…") : t("Restore")}
                    </Button>
                    {item.kind === "bundle" || item.kind === "document" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void forget(item)}
                        disabled={restoring === item.id}
                        aria-label={t("Delete {{name}} for good", { name: item.name })}
                      >
                        {t("Delete for good")}
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
    </section>
  );
}

const KIND_WORD: Record<TrashKind, string> = {
  agent: msg("Agent"),
  bundle: msg("Folder"),
  document: msg("Document"),
  session: msg("Thread"),
  routine: msg("Routine"),
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function daysLeft(purgesAt: number, days: number): number {
  const ms = purgesAt - Date.now();
  if (!Number.isFinite(ms)) return days;
  return Math.ceil(ms / 86_400_000);
}
