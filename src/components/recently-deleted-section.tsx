import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FileText, Library, Undo2 } from "lucide-react";
import { SectionHeading } from "@/components/page-container";
import { DataRow, EmptyState } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { api, ApiError, type TrashItem, type TrashKind } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { formatRelative } from "@/lib/relative-time";
import { toast } from "sonner";

const ICONS: Record<TrashKind, typeof Bot> = {
  agent: Bot,
  bundle: Library,
  document: FileText,
};

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
      toast.success(`${item.name} restored`);
    } catch (e) {
      // The one message worth passing through verbatim: a document whose bundle
      // is also deleted cannot come back on its own, and the server says which
      // to press first.
      toast.error(e instanceof ApiError ? e.message : "Couldn't restore that");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="mt-16">
      <SectionHeading
        title="Recently deleted"
        turn={`Yours for ${days} more days.`}
        meta={items.length > 0 ? `${items.length} waiting` : undefined}
      />

      <div className="mt-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing deleted"
            description={`Agents, knowledge bundles and documents wait here for ${days} days before they go for good. Their conversations and routines come back with them.`}
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {items.map((item) => {
              const Icon = ICONS[item.kind];
              return (
                <li key={`${item.kind}:${item.id}`}>
                  <DataRow
                    icon={
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-dashed border-border text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </span>
                    }
                    title={item.name}
                    meta={metaFor(item, days)}
                    trailing={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => restore(item)}
                        disabled={restoring === item.id}
                      >
                        <Undo2 className="h-4 w-4" />
                        {restoring === item.id ? "Restoring…" : "Restore"}
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One line saying what it was, who took it, and how long is left.
 *
 * The deleter is omitted rather than guessed when it is null — that happens
 * when the person has since closed their own account, and "deleted by someone"
 * is worth less than saying nothing.
 */
function metaFor(item: TrashItem, days: number): string {
  const parts: string[] = [
    item.kind === "document" && item.parentName ? item.parentName : item.kind,
  ];
  parts.push(item.deletedBy ? `deleted by ${item.deletedBy}` : "deleted");
  parts.push(formatRelative(item.deletedAt));
  parts.push(remaining(item.purgesAt, days));
  return parts.join(" · ");
}

function remaining(purgesAt: number, days: number): string {
  const ms = purgesAt - Date.now();
  if (!Number.isFinite(ms)) return `${days} days left`;
  const left = Math.ceil(ms / 86_400_000);
  if (left <= 0) return "going any moment";
  if (left === 1) return "1 day left";
  return `${left} days left`;
}
