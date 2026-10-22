import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { SectionLabel } from "@/components/section";
import { StatusWord } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { api, ApiError, type WorkspaceExport } from "@/lib/api-client";
import { formatFileSize } from "@/lib/file-size";
import { cn } from "@/lib/utils";

/** "20 October 2026". */
const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * Settings › Export and deletion › Export (A27): ask for everything as a zip,
 * prepared in the background and mailed to you (0132), and the exports asked
 * for before — each yours to download, or somebody else's to.
 *
 * It holds what the person who asked can see — somebody else's private
 * threads are not in their copy, which is also why only they may download
 * it. The old synchronous download stays, for an install whose scheduled
 * work does not run.
 */
export function ExportWorkspaceSection({
  workspaceId,
  isAdmin,
  highlight,
}: {
  workspaceId?: string;
  isAdmin: boolean;
  /** An export the email's link pointed at. */
  highlight?: string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const key = ["exports", workspaceId];
  const { data: exports = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.exports.list(workspaceId!),
    enabled: !!workspaceId && isAdmin,
    // While one is being prepared, look again now and then.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((e) => e.status === "queued" || e.status === "running")
        ? 15_000
        : false,
  });
  const inProgress = exports.some((e) => e.status === "queued" || e.status === "running");

  const run = async (id: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await work();
      if (done) toast.success(done);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't do that");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionLabel>Export</SectionLabel>
      <Field
        label="Everything as a zip"
        help="Threads, documents as they were uploaded, agents and routines, with the SQL to put them back into a Covan you run yourself. Ready within an hour; the link is emailed to you and works for 7 days."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!workspaceId || !isAdmin || inProgress || busy === "request"}
            onClick={() =>
              workspaceId &&
              void run(
                "request",
                () => api.exports.request(workspaceId),
                "Export requested — we'll email you when it's ready",
              )
            }
          >
            {inProgress ? "Preparing…" : "Request export"}
          </Button>
          <Button
            variant="ghost"
            disabled={!workspaceId || busy === "now"}
            onClick={() =>
              workspaceId &&
              void run("now", () => api.workspace.exportArchive(workspaceId), "Export downloaded")
            }
          >
            {busy === "now" ? "Building…" : "Download it now instead"}
          </Button>
        </div>
        <p className="mt-2 text-meta text-muted-foreground">
          Owners and admins only. It holds what you can see: somebody else&rsquo;s private threads
          are not in your copy. Delivery channels come back without their secrets, so a restore
          brings every routine back paused.
        </p>
      </Field>

      {isAdmin && exports.length > 0 && (
        <Field label="Previous exports">
          <ul className="m-0 max-w-[560px] list-none p-0">
            {exports.map((e) => (
              <ExportRow
                key={e.id}
                item={e}
                highlighted={e.id === highlight}
                busy={busy === e.id}
                onDownload={() => void run(e.id, () => api.exports.download(e.id))}
              />
            ))}
          </ul>
        </Field>
      )}
    </>
  );
}

function ExportRow({
  item,
  highlighted,
  busy,
  onDownload,
}: {
  item: WorkspaceExport;
  highlighted: boolean;
  busy: boolean;
  onDownload: () => void;
}) {
  return (
    <li
      className={cn(
        "flex min-h-11 items-center gap-3 border-b border-hairline text-sm last:border-b-0",
        highlighted && "bg-surface-muted",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {day(item.createdAt)}
        <span className="text-muted-foreground">
          {item.sizeBytes ? ` · ${formatFileSize(item.sizeBytes)}` : ""} · requested by{" "}
          {item.mine ? "you" : (item.requestedBy?.name ?? "an admin")}
        </span>
      </span>
      {item.status === "ready" ? (
        item.mine ? (
          <Button variant="secondary" size="sm" onClick={onDownload} disabled={busy}>
            {busy ? "Downloading…" : "Download"}
          </Button>
        ) : (
          // Their copy holds their private threads; it is theirs to download.
          <span className="text-meta text-muted-foreground">Theirs to download</span>
        )
      ) : item.status === "queued" || item.status === "running" ? (
        <StatusWord state="running" className="text-meta">
          Preparing
        </StatusWord>
      ) : item.status === "failed" ? (
        <span className="text-meta text-destructive">{item.error ?? "Failed"}</span>
      ) : (
        <span className="text-meta text-muted-foreground">Expired</span>
      )}
    </li>
  );
}
