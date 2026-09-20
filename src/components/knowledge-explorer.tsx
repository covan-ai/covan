import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  LayoutGrid,
  List,
  MoreVertical,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";

import { api } from "@/lib/api-client";
import { bundleDocumentsKey, useAgentsStore, type Agent } from "@/lib/agents-store";
import { Chip, EmptyState } from "@/components/section-card";
import { DocumentPreviewDialog } from "@/components/document-preview-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALLOWED_EXT, validateUpload } from "@/lib/uploads";
import { formatFileSize } from "@/lib/file-size";
import { dropPayload, rangeSelect } from "@/lib/knowledge-selection";
import { documentAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

type ExplorerDocument = Agent["documents"][number];

/**
 * What the right-hand pane is showing: one bundle, or everything an agent reads.
 *
 * `all` exists only in the agent context, where it is the list this tab has
 * always shown — every document in every attached bundle. It is a real question
 * ("what does this agent know?") that no single bundle answers, so it stays,
 * as the folder the tab opens on.
 */
type Selection = { kind: "all" } | { kind: "bundle"; id: string };

type SortKey = "name" | "size" | "createdAt" | "indexed" | "citations";
type Sort = { key: SortKey; dir: "asc" | "desc" };

/**
 * The questions a list of files is asked once there are too many to read.
 *
 * Both are about a document that is not doing its job: one nothing can retrieve,
 * one nobody has revisited in three months. A filter appears only when it would
 * find something, so a workspace where neither is true has no filter row at all.
 *
 * "Nothing reads this" is missing on purpose. It is true of a whole bundle or of
 * none of it — every file in a bundle is reachable exactly when that bundle is
 * attached — so it belongs to the folder, and it is on the folder: in the rail
 * and under the name of the open one.
 */
type FilterKey = "all" | "unindexed" | "stale";

/** Above this many bundles the rail gets a search of its own. */
const RAIL_SEARCH_AFTER = 8;

/** How each filter reads in the sentence an empty pane says. */
const FILTER_PHRASE: Record<Exclude<FilterKey, "all">, string> = {
  unindexed: "waiting to be indexed",
  stale: "older than ninety days",
};

const ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(",");

type Uploading = { id: string; name: string; progress: number };

/**
 * The Knowledge explorer: bundles down the side, documents in the middle.
 *
 * One component with two entrances. `/knowledge` mounts it bare, where it is
 * the workspace's files; an agent's Knowledge tab mounts it with `agent`, where
 * the same rail also carries the switch that decides what that agent can read.
 * Written once because the two screens were never going to be allowed to
 * disagree about what a bundle contains, and two implementations of a file list
 * is two of everything — two sorts, two empty states, two ideas of what a row
 * says.
 *
 * What the tab could not do before: read a bundle nobody had attached. The
 * documents came from the agent, so an unattached bundle was a name and a count
 * with nothing behind it — including every bundle on the day it was made.
 */
export function KnowledgeExplorer({ agent }: { agent?: Agent }) {
  const store = useAgentsStore();
  const { bundles, canWrite } = store;

  const [chosen, setChosen] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [view, setView] = useState<"list" | "grid">("list");
  const [previewing, setPreviewing] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  /**
   * Documents whose move has been asked for and not yet answered, against the
   * bundle they are going to.
   *
   * The row leaves for its new bundle the moment it is dropped rather than when
   * the server agrees, because a file that stays where it was for a second
   * after being dragged out of it reads as a drag that did not take. A refusal
   * puts it back — 0024 does refuse, when a document's passages cannot follow
   * it — and the toast says which file and why.
   */
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  const sensors = useSensors(
    // Six pixels of travel before a press becomes a drag, so pressing a row and
    // letting go still opens the file.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // Derived rather than kept in sync by an effect: the first bundle is the
  // answer until somebody picks another, and a bundle that has since been
  // deleted falls back to it rather than leaving the pane pointed at nothing.
  const fallback: Selection | null = agent
    ? { kind: "all" }
    : bundles.length > 0
      ? { kind: "bundle", id: bundles[0].id }
      : null;
  const selection =
    chosen && (chosen.kind === "all" || bundles.some((b) => b.id === chosen.id))
      ? chosen
      : fallback;
  const openBundle =
    selection?.kind === "bundle" ? (bundles.find((b) => b.id === selection.id) ?? null) : null;

  // One bundle's contents. Not asked for at all while the agent's own list is
  // showing, which is the tab's opening state and needs no request of its own.
  const bundleDocuments = useQuery({
    queryKey: bundleDocumentsKey(openBundle?.id ?? ""),
    queryFn: () => api.bundles.documents(openBundle!.id),
    enabled: !!openBundle,
  });

  const citations = useQuery({
    queryKey: ["bundle-citations"],
    queryFn: () => api.bundles.citations(),
    staleTime: 5 * 60_000,
  });
  // Both memoised only so the sort below is not asked to run again on every
  // render: `?? {}` and `?? []` are new objects each time, and they are what
  // the sort depends on.
  const counts = useMemo(() => citations.data?.counts ?? {}, [citations.data]);
  // The deps are the parts rather than `selection` itself, which is derived
  // above and is a new object on every render.
  const openId = selection?.kind === "bundle" ? selection.id : null;
  const readable = agent?.bundleIds;
  const documents = useMemo<ExplorerDocument[]>(() => {
    const base = openId === null ? (agent?.documents ?? []) : (bundleDocuments.data ?? []);
    if (Object.keys(moved).length === 0) return base;
    return base.flatMap((doc) => {
      const to = moved[doc.id];
      if (!to) return [doc];
      // Gone from the folder it left. In the agent's own list it is only gone
      // if it landed somewhere that agent does not read; otherwise it stays,
      // wearing the name of its new bundle.
      if (openId !== null) return to === openId ? [{ ...doc, bundleId: to }] : [];
      if (readable && !readable.includes(to)) return [];
      return [{ ...doc, bundleId: to }];
    });
  }, [openId, agent?.documents, readable, bundleDocuments.data, moved]);

  /**
   * Which agents can read each bundle, by name.
   *
   * Computed here rather than asked for: the store already holds every agent
   * and the bundles it has attached, so "who reads this file" is a join the
   * browser can do, and one the server would have to be asked for per document.
   */
  const readersByBundle = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const a of store.agents) {
      for (const id of a.bundleIds) (map[id] ??= []).push(a.name);
    }
    return map;
  }, [store.agents]);

  // Counted before the search and after nothing, so a filter's number is how
  // many files in this folder it would find — not how many of what is on the
  // screen right now.
  const tallies = useMemo(
    () => ({
      unindexed: documents.filter((d) => !d.indexed).length,
      stale: documents.filter((d) => documentAge(d.createdAt).stale).length,
    }),
    [documents],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = documents.filter((d) => {
      if (needle && !d.name.toLocaleLowerCase().includes(needle)) return false;
      if (filter === "unindexed") return !d.indexed;
      if (filter === "stale") return documentAge(d.createdAt).stale;
      return true;
    });
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => factor * compare(a, b, sort.key, counts));
  }, [documents, query, filter, sort, counts]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  const markBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * Opening a folder empties the selection.
   *
   * The rows it names are about to leave the screen, and a Delete pressed after
   * a change of folder must not reach back into the one before it.
   */
  const openFolder = (next: Selection) => {
    setChosen(next);
    setSelected(new Set());
    setAnchor(null);
  };

  // Ticked rows, as documents — read from the list rather than from the set, so
  // a file that has been deleted or moved away stops being counted the moment
  // it stops being here.
  const selectedDocs = useMemo(
    () => documents.filter((d) => selected.has(d.id)),
    [documents, selected],
  );

  const pick = (id: string, range: boolean) => {
    const order = visible.map((d) => d.id);
    setSelected((prev) => {
      if (range) return rangeSelect(order, anchor, id, prev);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const addFiles = (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    if (!openBundle) {
      toast.error("Pick a bundle to upload into first.");
      return;
    }
    const bundleId = openBundle.id;
    for (const file of list) {
      const check = validateUpload(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      const id = `u_${crypto.randomUUID()}`;
      setUploading((prev) => [...prev, { id, name: file.name, progress: 0 }]);
      store
        .uploadToBundle(bundleId, file, (pct) =>
          setUploading((prev) => prev.map((u) => (u.id === id ? { ...u, progress: pct } : u))),
        )
        .then((doc) => {
          setUploading((prev) => prev.filter((u) => u.id !== id));
          if (doc.indexed) toast.success(`Added ${file.name}`);
          else
            toast.warning(
              `${file.name} went in but could not be indexed, so answers won't be grounded in it.`,
            );
        })
        .catch((err) => {
          setUploading((prev) => prev.filter((u) => u.id !== id));
          toast.error(err?.message ? `Upload failed: ${err.message}` : "Upload failed");
        });
    }
  };

  const moveMany = async (docs: ExplorerDocument[], bundleId: string) => {
    if (docs.length === 0) return;
    const where = bundles.find((b) => b.id === bundleId)?.name ?? "the bundle";
    setMoved((prev) => ({ ...prev, ...Object.fromEntries(docs.map((d) => [d.id, bundleId])) }));
    const outcome = await eachInTurn(docs, {
      progress: (done, total) => `Moving ${done} of ${total} to ${where}…`,
      run: (doc) => store.moveDocument(doc.id, bundleId),
      onSettled: (doc, ok) => {
        markBusy(doc.id, false);
        // A refusal is the one case where the row has to come back: the
        // document is still in the bundle it was dragged out of.
        if (!ok) setMoved((prev) => without(prev, doc.id));
      },
      onStart: (doc) => markBusy(doc.id, true),
    });
    setMoved((prev) => {
      const next = { ...prev };
      for (const doc of docs) delete next[doc.id];
      return next;
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const doc of docs) next.delete(doc.id);
      return next;
    });
    announce(outcome, {
      one: (name) => `Moved ${name} to ${where}`,
      many: (n) => `Moved ${n} files to ${where}`,
      verb: "Move",
      partial: (n, total) => `Moved ${n} of ${total} to ${where}.`,
    });
  };

  const move = (doc: ExplorerDocument, bundleId: string) => void moveMany([doc], bundleId);

  const reindex = (doc: ExplorerDocument) => {
    markBusy(doc.id, true);
    store
      .reindexDocument(doc.id)
      .then((d) =>
        toast.success(
          `Reindexed ${doc.name} — ${d.chunkCount} ${d.chunkCount === 1 ? "passage" : "passages"}`,
        ),
      )
      .catch((err) =>
        toast.error(err?.message ? `Reindex failed: ${err.message}` : "Reindex failed"),
      )
      .finally(() => markBusy(doc.id, false));
  };

  const removeMany = async (docs: ExplorerDocument[]) => {
    if (docs.length === 0) return;
    const what = docs.length === 1 ? `"${docs[0].name}"` : `${docs.length} files`;
    if (!confirm(`Delete ${what}? They wait 30 days in Settings → Recently deleted.`)) return;
    const outcome = await eachInTurn(docs, {
      progress: (done, total) => `Deleting ${done} of ${total}…`,
      run: (doc) => store.removeDocument(doc.id),
      onStart: (doc) => markBusy(doc.id, true),
      onSettled: (doc) => markBusy(doc.id, false),
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const doc of docs) next.delete(doc.id);
      return next;
    });
    announce(outcome, {
      one: (name) => `Deleted ${name}`,
      many: (n) => `Deleted ${n} files`,
      verb: "Delete",
      partial: (n, total) => `Deleted ${n} of ${total}.`,
    });
  };

  const remove = (doc: ExplorerDocument) => void removeMany([doc]);

  /**
   * A file dropped on a bundle in the rail.
   *
   * The whole selection goes if the row that was dragged is part of it, which is
   * what every file manager does and what makes the checkboxes worth having
   * under a pointer. `dropPayload` decides; this only says where.
   */
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const over = event.over?.id;
    if (!over || !canWrite) return;
    const bundleId = String(over);
    void moveMany(dropPayload(String(event.active.id), bundleId, selected, documents), bundleId);
  };

  const draggedName = dragging ? documents.find((d) => d.id === dragging)?.name : undefined;
  const draggedCount = dragging && selected.has(dragging) ? selectedDocs.length : 1;

  const loading = selection?.kind === "bundle" && bundleDocuments.isPending;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDragging(String(e.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-start">
        <BundleRail
          bundles={bundles}
          agent={agent}
          selection={selection}
          onSelect={openFolder}
          canWrite={canWrite}
          dropping={!!dragging}
          readers={agent ? null : readersByBundle}
        />

        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <PaneHeader
            openBundle={openBundle}
            agent={agent}
            count={documents.length}
            canWrite={canWrite}
            view={view}
            onView={setView}
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            tallies={tallies}
            readers={agent || !openBundle ? null : (readersByBundle[openBundle.id] ?? [])}
          />

          {selectedDocs.length > 0 ? (
            <SelectionBar
              selected={selectedDocs}
              total={visible.length}
              bundles={bundles.filter((b) => b.id !== openId)}
              onSelectAll={() => setSelected(new Set(visible.map((d) => d.id)))}
              onClear={() => {
                setSelected(new Set());
                setAnchor(null);
              }}
              onMove={(bundleId) => void moveMany(selectedDocs, bundleId)}
              onDelete={() => void removeMany(selectedDocs)}
            />
          ) : null}

          {loading ? (
            <p className="px-5 py-12 text-center text-sm text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={query || filter !== "all" ? "Nothing matches" : "Nothing here yet"}
                description={
                  // The filter before the search, because a filter left on from
                  // another folder is the one an empty pane does not explain by
                  // itself.
                  filter !== "all"
                    ? query
                      ? `No file called "${query}" is ${FILTER_PHRASE[filter]}. Press All to see every file again.`
                      : `Nothing here is ${FILTER_PHRASE[filter]}. Press All to see every file again.`
                    : query
                      ? `No file in this ${selection?.kind === "all" ? "agent" : "bundle"} is called "${query}".`
                      : selection?.kind === "all"
                        ? "This agent has no bundle attached, or the ones it has are empty. Pick a bundle on the left and switch it on."
                        : canWrite
                          ? "Drop files below and they're chunked and embedded for retrieval in chat."
                          : "Nothing has been uploaded to this bundle yet."
                }
              />
            </div>
          ) : view === "list" ? (
            <DocumentTable
              documents={visible}
              bundles={bundles}
              showBundle={selection?.kind === "all"}
              sort={sort}
              onSort={toggleSort}
              counts={counts}
              busy={busy}
              canWrite={canWrite}
              selected={selected}
              onPick={pick}
              onSelectAll={() => setSelected(new Set(visible.map((d) => d.id)))}
              onClearSelection={() => setSelected(new Set())}
              onOpen={(d) => setPreviewing({ id: d.id, name: d.name })}
              onMove={move}
              onReindex={reindex}
              onRemove={remove}
              onOpenBundle={(id) => openFolder({ kind: "bundle", id })}
            />
          ) : (
            <DocumentGrid
              documents={visible}
              busy={busy}
              canWrite={canWrite}
              bundles={bundles}
              selected={selected}
              onPick={pick}
              onOpen={(d) => setPreviewing({ id: d.id, name: d.name })}
              onMove={move}
              onReindex={reindex}
              onRemove={remove}
            />
          )}

          {canWrite ? (
            <UploadWell bundle={openBundle} uploading={uploading} onFiles={addFiles} />
          ) : null}
        </section>

        {previewing ? (
          <DocumentPreviewDialog
            documentId={previewing.id}
            name={previewing.name}
            onClose={() => setPreviewing(null)}
          />
        ) : null}
      </div>

      {/* What is in the hand while it is being dragged. Without it a drag is a
          row that dims and a rail that lights up, with nothing in between. */}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="max-w-56 truncate">
              {draggedCount > 1 ? `${draggedCount} files` : draggedName}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function compare(
  a: ExplorerDocument,
  b: ExplorerDocument,
  key: SortKey,
  counts: Record<string, number>,
): number {
  switch (key) {
    case "size":
      return a.size - b.size;
    case "createdAt":
      return a.createdAt - b.createdAt;
    case "indexed":
      return Number(a.indexed) - Number(b.indexed) || a.chunkCount - b.chunkCount;
    case "citations":
      return (counts[a.id] ?? 0) - (counts[b.id] ?? 0);
    default:
      // Locale-aware, so "Ürünler" sorts where a Turkish reader expects it and
      // not after every Z.
      return a.name.localeCompare(b.name);
  }
}

/* ------------------------------------------------------- acting on a batch */

type Outcome = { ok: string[]; failed: { name: string; reason: string }[] };

function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return message || "something went wrong";
}

function without(record: Record<string, string>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * One request per document, in order, with a toast that counts them off.
 *
 * Sequential rather than parallel, and that is the decision here. A move can be
 * refused — 0024 will not move a document whose passages cannot follow it — and
 * twenty PATCHes in flight at once answer "some of those failed" with no way to
 * say which, while a batch that stops at the first refusal leaves the rest
 * undone for no reason. So every one is asked for, every answer is kept, and
 * what comes back is the whole story: what moved, what did not, and why not.
 *
 * The progress toast is only for a real batch. One file gets one sentence when
 * it is done, which is what it got before any of this existed.
 */
async function eachInTurn(
  docs: ExplorerDocument[],
  opts: {
    progress: (done: number, total: number) => string;
    run: (doc: ExplorerDocument) => Promise<unknown>;
    onStart?: (doc: ExplorerDocument) => void;
    onSettled?: (doc: ExplorerDocument, ok: boolean) => void;
  },
): Promise<Outcome> {
  const outcome: Outcome = { ok: [], failed: [] };
  const toastId = docs.length > 1 ? `knowledge-batch-${docs[0].id}` : null;
  if (toastId) toast.loading(opts.progress(0, docs.length), { id: toastId });

  for (const doc of docs) {
    opts.onStart?.(doc);
    let ok = true;
    try {
      await opts.run(doc);
      outcome.ok.push(doc.name);
    } catch (err) {
      ok = false;
      outcome.failed.push({ name: doc.name, reason: reasonOf(err) });
    }
    opts.onSettled?.(doc, ok);
    if (toastId) {
      toast.loading(opts.progress(outcome.ok.length + outcome.failed.length, docs.length), {
        id: toastId,
      });
    }
  }

  if (toastId) toast.dismiss(toastId);
  return outcome;
}

/**
 * What happened, in one sentence.
 *
 * A partial failure names the first file that refused and its reason rather
 * than counting failures, because "2 of 5 moved" leaves somebody to work out
 * which three and why — and the reason is usually the whole answer.
 */
function announce(
  outcome: Outcome,
  words: {
    one: (name: string) => string;
    many: (n: number) => string;
    verb: string;
    partial: (done: number, total: number) => string;
  },
) {
  const total = outcome.ok.length + outcome.failed.length;
  if (outcome.failed.length === 0) {
    toast.success(total === 1 ? words.one(outcome.ok[0]) : words.many(total));
    return;
  }
  const [first, ...rest] = outcome.failed;
  if (total === 1) {
    toast.error(`${words.verb} failed: ${first.reason}`);
    return;
  }
  const more = rest.length > 0 ? ` And ${rest.length} more failed.` : "";
  toast.error(`${words.partial(outcome.ok.length, total)} ${first.name} — ${first.reason}${more}`);
}

/**
 * What can be done to every ticked row at once.
 *
 * It appears when the first row is ticked and replaces nothing, so the row
 * menu is still there for one file. Select-all lives here rather than only in
 * the table header, which folds away below md — the header checkbox is the
 * accelerator, this is the one that is always on the screen.
 */
function SelectionBar({
  selected,
  total,
  bundles,
  onSelectAll,
  onClear,
  onMove,
  onDelete,
}: {
  selected: ExplorerDocument[];
  total: number;
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  onSelectAll: () => void;
  onClear: () => void;
  onMove: (bundleId: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-muted px-4 py-2 text-[13px]">
      <span className="font-medium">{selected.length} selected</span>
      {selected.length < total ? (
        <Button type="button" variant="ghost" size="sm" onClick={onSelectAll}>
          Select all {total}
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>

      <span className="flex-1" />

      {bundles.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <FolderOpen className="mr-2 h-4 w-4" />
              Move to
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-64 w-52 overflow-y-auto">
            {bundles.map((b) => (
              <DropdownMenuItem key={b.id} onSelect={() => onMove(b.id)}>
                <span className="truncate">{b.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={onDelete}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- the rail */

/**
 * The bundles, as folders.
 *
 * In the agent context they arrive in two groups, and the split is the point:
 * the top group is what this agent reads, the bottom is everything else the
 * workspace has. Grouping rather than hiding, because attaching one is done
 * here — a rail filtered down to the attached bundles would be a rail with no
 * way to attach the next one.
 */
function BundleRail({
  bundles,
  agent,
  selection,
  onSelect,
  canWrite,
  dropping,
  readers,
}: {
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  agent?: Agent;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  canWrite: boolean;
  /** Something is being dragged, so every bundle says it will take it. */
  dropping: boolean;
  /**
   * Which agents read each bundle, or null in an agent's own tab — there the
   * rail is already split into what this agent reads and what it does not, and
   * naming the others would answer a question the screen is not about.
   */
  readers: Record<string, string[]> | null;
}) {
  const store = useAgentsStore();
  const [railQuery, setRailQuery] = useState("");

  // A search rather than a "hide empty bundles" switch, which was the other
  // way to make a long rail shorter: the empty bundle is the one somebody is
  // looking for, because it is the one waiting to be filled.
  const needle = railQuery.trim().toLocaleLowerCase();
  const matching = needle
    ? bundles.filter((b) => b.name.toLocaleLowerCase().includes(needle))
    : bundles;
  const attached = agent ? matching.filter((b) => agent.bundleIds.includes(b.id)) : matching;
  const detached = agent ? matching.filter((b) => !agent.bundleIds.includes(b.id)) : [];

  return (
    <aside className="overflow-hidden rounded-xl border border-border bg-surface">
      {bundles.length > RAIL_SEARCH_AFTER ? (
        <div className="relative border-b border-hairline p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={railQuery}
            onChange={(e) => setRailQuery(e.target.value)}
            placeholder="Find a bundle"
            aria-label="Find a bundle by name"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      ) : null}

      {agent ? (
        <button
          type="button"
          onClick={() => onSelect({ kind: "all" })}
          className={cn(
            "flex w-full items-center gap-2.5 border-b border-hairline px-4 py-3 text-left text-sm transition-colors",
            selection?.kind === "all" ? "bg-surface-hover font-medium" : "hover:bg-surface-hover",
          )}
        >
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Everything {agent.name} reads</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {agent.documents.length}
          </span>
        </button>
      ) : null}

      {bundles.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No bundles yet.{canWrite ? " Make the first one below." : ""}
        </p>
      ) : matching.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {`No bundle is called "${railQuery.trim()}".`}
        </p>
      ) : (
        <>
          {agent ? <RailHeading>Attached</RailHeading> : null}
          {attached.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">
              Nothing attached, so this agent reads nothing but its persona.
            </p>
          ) : (
            attached.map((b) => (
              <BundleRailRow
                key={b.id}
                bundle={b}
                agent={agent}
                readers={readers ? (readers[b.id] ?? []) : null}
                selected={selection?.kind === "bundle" && selection.id === b.id}
                onSelect={() => onSelect({ kind: "bundle", id: b.id })}
                canWrite={canWrite}
                dropping={dropping}
                store={store}
              />
            ))
          )}
          {detached.length > 0 ? (
            <>
              <RailHeading>Not attached</RailHeading>
              {detached.map((b) => (
                <BundleRailRow
                  key={b.id}
                  bundle={b}
                  agent={agent}
                  readers={readers ? (readers[b.id] ?? []) : null}
                  selected={selection?.kind === "bundle" && selection.id === b.id}
                  onSelect={() => onSelect({ kind: "bundle", id: b.id })}
                  canWrite={canWrite}
                  dropping={dropping}
                  store={store}
                />
              ))}
            </>
          ) : null}
        </>
      )}

      {canWrite ? <NewBundleForm onCreated={(id) => onSelect({ kind: "bundle", id })} /> : null}
    </aside>
  );
}

function RailHeading({ children }: { children: ReactNode }) {
  return (
    <p className="border-b border-hairline bg-surface-muted px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </p>
  );
}

function BundleRailRow({
  bundle,
  agent,
  readers,
  selected,
  onSelect,
  canWrite,
  dropping,
  store,
}: {
  bundle: ReturnType<typeof useAgentsStore>["bundles"][number];
  agent?: Agent;
  /** The agents that read it, on the workspace page; null in an agent's tab. */
  readers: string[] | null;
  selected: boolean;
  onSelect: () => void;
  canWrite: boolean;
  dropping: boolean;
  store: ReturnType<typeof useAgentsStore>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(bundle.name);
  const { setNodeRef, isOver } = useDroppable({ id: bundle.id, disabled: !canWrite });

  const commit = () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === bundle.name) return;
    store
      .updateBundle(bundle.id, { name })
      .then(() => toast.success(`Renamed to ${name}`))
      .catch((err) =>
        toast.error(err?.message ? `Rename failed: ${err.message}` : "Rename failed"),
      );
  };

  if (renaming) {
    return (
      <div className="border-b border-hairline px-3 py-2">
        <Input
          autoFocus
          value={draft}
          aria-label={`Rename ${bundle.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setDraft(bundle.name);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-2 border-b border-hairline pl-1 pr-2 transition-colors",
        selected ? "bg-surface-hover" : "hover:bg-surface-hover",
        // Dashed while anything is in the air, so every place a file can land
        // says so; solid amber under the one it would land on now.
        dropping && "border-dashed",
        isOver && "bg-surface-hover ring-1 ring-inset ring-accent-orange",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${bundle.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-3 text-left text-sm"
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", selected && "font-medium")}>{bundle.name}</span>
          <span
            className={cn(
              "block truncate text-xs text-muted-foreground",
              // The one state worth a colour in a list of folders: a bundle no
              // agent has attached is a folder nothing can read out of.
              readers?.length === 0 && "text-amber-700 dark:text-amber-400",
            )}
          >
            {bundle.documentCount} {bundle.documentCount === 1 ? "file" : "files"}
            {readers
              ? readers.length === 0
                ? " · no agent reads it"
                : ` · ${listOf(readers)}`
              : ""}
            {bundle.description ? ` · ${bundle.description}` : ""}
          </span>
        </span>
      </button>

      {/* Attaching changes what the agent knows for everyone who uses it, so a
          viewer sees the state and cannot change it. */}
      {agent ? (
        <Switch
          checked={agent.bundleIds.includes(bundle.id)}
          disabled={!canWrite}
          onCheckedChange={(on) =>
            on ? store.attachBundle(agent.id, bundle.id) : store.detachBundle(agent.id, bundle.id)
          }
          aria-label={`Attach ${bundle.name} to ${agent.name}`}
        />
      ) : null}

      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Actions for ${bundle.name}`}
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(bundle.name);
                setRenaming(true);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                if (
                  confirm(
                    `Delete "${bundle.name}"? Its documents go with it and it detaches from every agent. It waits 30 days in Settings → Recently deleted, and restoring it brings the documents back too.`,
                  )
                ) {
                  store.removeBundle(bundle.id);
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete bundle
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function NewBundleForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { createBundle } = useAgentsStore();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    createBundle(trimmed)
      .then((bundle) => {
        setName("");
        onCreated(bundle.id);
        toast.success(`Created ${bundle.name}`);
      })
      .catch((err) => toast.error(err?.message ? `Create failed: ${err.message}` : "Create failed"))
      .finally(() => setCreating(false));
  };

  return (
    <div className="flex items-center gap-2 p-3">
      <Input
        placeholder="New bundle"
        value={name}
        disabled={creating}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            create();
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={create}
        disabled={creating || !name.trim()}
      >
        Add
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- the content */

function PaneHeader({
  openBundle,
  agent,
  count,
  canWrite,
  view,
  onView,
  query,
  onQuery,
  filter,
  onFilter,
  tallies,
  readers,
}: {
  openBundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  agent?: Agent;
  count: number;
  canWrite: boolean;
  view: "list" | "grid";
  onView: (v: "list" | "grid") => void;
  query: string;
  onQuery: (q: string) => void;
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  tallies: { unindexed: number; stale: number };
  /**
   * The agents that read the open bundle, or null in an agent's own tab, where
   * the answer is the agent whose tab it is.
   */
  readers: string[] | null;
}) {
  // A filter with nothing to find is not offered — except the one that is on,
  // which has to stay on the screen or there would be no way back to All.
  const chips = (
    [
      { key: "unindexed", label: "Needs indexing", count: tallies.unindexed },
      { key: "stale", label: "Older than 90 days", count: tallies.stale },
    ] as const
  ).filter((c) => c.count > 0 || filter === c.key);
  const title = openBundle
    ? openBundle.name
    : agent
      ? `Everything ${agent.name} reads`
      : "Knowledge";

  return (
    <div className="border-b border-hairline px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          <span className="shrink-0 text-muted-foreground">Knowledge</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-dm text-[17px] font-medium">{title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {count} {count === 1 ? "file" : "files"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-sm border border-hairline p-0.5">
          <ViewButton active={view === "list"} onClick={() => onView("list")} label="List view">
            <List className="h-4 w-4" />
          </ViewButton>
          <ViewButton active={view === "grid"} onClick={() => onView("grid")} label="Grid view">
            <LayoutGrid className="h-4 w-4" />
          </ViewButton>
        </div>
      </div>

      <div className="relative mt-2.5">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search files by name"
          aria-label="Search files by name"
          className="h-8 pl-8 text-[13px]"
        />
      </div>

      {/* Who can actually retrieve what is in here. A bundle nobody has
          attached is a folder of files no answer can ever stand on, and the
          count in the rail says nothing about that. */}
      {readers ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          {readers.length === 0
            ? "No agent reads this bundle yet — attach it from an agent's Knowledge tab and everything in it becomes retrievable."
            : `Read by ${listOf(readers)}.`}
        </p>
      ) : null}

      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <FilterChip active={filter === "all"} onClick={() => onFilter("all")}>
            All
          </FilterChip>
          {chips.map((c) => (
            <FilterChip
              key={c.key}
              active={filter === c.key}
              onClick={() => onFilter(c.key)}
              // Spelled out, because the number sits against the label with no
              // space between them and "Needs indexing3" is what is read out.
              label={`${c.label}, ${c.count} ${c.count === 1 ? "file" : "files"}`}
            >
              {c.label}
              <span className="ml-1.5 tabular-nums opacity-70">{c.count}</span>
            </FilterChip>
          ))}
        </div>
      ) : null}

      {openBundle && !canWrite ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          You can read everything here. Uploading, moving and deleting are a member's job.
        </p>
      ) : null}
    </div>
  );
}

/** "Ada", "Ada and Ops bot", "Ada, Ops bot and 2 more". */
function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function FilterChip({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "rounded-sm border px-2 py-1 text-xs transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-hairline text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "rounded-sm p-1 transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

type RowActions = {
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  busy: Set<string>;
  canWrite: boolean;
  selected: ReadonlySet<string>;
  onPick: (id: string, range: boolean) => void;
  onOpen: (d: ExplorerDocument) => void;
  onMove: (d: ExplorerDocument, bundleId: string) => void;
  onReindex: (d: ExplorerDocument) => void;
  onRemove: (d: ExplorerDocument) => void;
};

function DocumentTable({
  documents,
  showBundle,
  sort,
  onSort,
  counts,
  onOpenBundle,
  onSelectAll,
  onClearSelection,
  ...actions
}: RowActions & {
  documents: ExplorerDocument[];
  showBundle: boolean;
  sort: Sort;
  onSort: (k: SortKey) => void;
  counts: Record<string, number>;
  onOpenBundle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}) {
  const allTicked = documents.length > 0 && documents.every((d) => actions.selected.has(d.id));

  return (
    <div>
      {/* The header is a row of buttons rather than a <thead>, because the rows
          below it are not a table on a phone: the columns fold into the line
          under the name and the header folds away with them. */}
      <div className="hidden items-center gap-3 border-b border-hairline px-5 py-2 text-xs text-muted-foreground md:flex">
        {actions.canWrite ? (
          <Checkbox
            checked={allTicked}
            onClick={() => (allTicked ? onClearSelection() : onSelectAll())}
            aria-label={allTicked ? "Clear the selection" : "Select every file here"}
          />
        ) : null}
        <span className="w-4 shrink-0" />
        <SortHeader className="flex-1" active={sort} sortKey="name" onSort={onSort}>
          Name
        </SortHeader>
        <SortHeader className="w-20 shrink-0" active={sort} sortKey="size" onSort={onSort}>
          Size
        </SortHeader>
        <SortHeader
          className="hidden w-28 shrink-0 lg:flex"
          active={sort}
          sortKey="createdAt"
          onSort={onSort}
        >
          Uploaded
        </SortHeader>
        <SortHeader className="w-24 shrink-0" active={sort} sortKey="indexed" onSort={onSort}>
          Status
        </SortHeader>
        <SortHeader
          className="hidden w-20 shrink-0 xl:flex"
          active={sort}
          sortKey="citations"
          onSort={onSort}
        >
          Answers
        </SortHeader>
        <span className="w-6 shrink-0" />
      </div>

      <div className="divide-y divide-hairline">
        {documents.map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            showBundle={showBundle}
            citations={counts[doc.id] ?? 0}
            onOpenBundle={onOpenBundle}
            {...actions}
          />
        ))}
      </div>
    </div>
  );
}

function SortHeader({
  children,
  sortKey,
  active,
  onSort,
  className,
}: {
  children: ReactNode;
  sortKey: SortKey;
  active: Sort;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const on = active.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${String(children).toLowerCase()}`}
      className={cn(
        "flex items-center gap-1 text-left transition-colors hover:text-foreground",
        on && "text-foreground",
        className,
      )}
    >
      {children}
      {on ? (
        active.dir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : null}
    </button>
  );
}

function DocumentRow({
  doc,
  showBundle,
  citations,
  bundles,
  busy,
  canWrite,
  selected,
  onPick,
  onOpen,
  onMove,
  onReindex,
  onRemove,
  onOpenBundle,
}: RowActions & {
  doc: ExplorerDocument;
  showBundle: boolean;
  citations: number;
  onOpenBundle: (id: string) => void;
}) {
  const age = documentAge(doc.createdAt);
  const bundle = doc.bundleId ? bundles.find((b) => b.id === doc.bundleId) : undefined;
  const ticked = selected.has(doc.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: doc.id,
    disabled: !canWrite,
  });

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-surface-hover",
        ticked && "bg-surface-hover",
        isDragging && "opacity-50",
      )}
    >
      {canWrite ? (
        <Checkbox
          checked={ticked}
          // The click rather than the change, because shift-clicking a second
          // row is what selects the range between them and only the event
          // knows the shift key was down.
          onClick={(e) => onPick(doc.id, e.shiftKey)}
          aria-label={`Select ${doc.name}`}
        />
      ) : null}

      {canWrite ? (
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${doc.name}`}
          title="Drag onto a bundle on the left to move it there"
          className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <FileText className="h-4 w-4" />
        </button>
      ) : (
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}

      <button
        type="button"
        onClick={() => onOpen(doc)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Open ${doc.name}`}
      >
        <span className="block truncate group-hover:underline [overflow-wrap:anywhere]">
          {doc.name}
        </span>
        {/* Where it came from, on the line under the name rather than as a
            chip or a colour: provenance is derived from a foreign key, and the
            document that needs no explanation at all is the one somebody
            uploaded. At every width, because it is the sort of thing a person
            wants to know before they trust the file — and a routine id with no
            name is a colleague's private routine, which is a thing the reader
            cannot be shown. */}
        {doc.routineId ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            Written by {doc.routineName ?? "a routine"}
          </span>
        ) : null}
        {/* The columns that fold away on a narrow screen say themselves here
            instead, so nothing is reachable only at desktop width. */}
        <span className="mt-0.5 block truncate text-xs text-muted-foreground md:hidden">
          {formatFileSize(doc.size)} · {age.label}
        </span>
        <span className="mt-0.5 hidden truncate text-xs text-muted-foreground md:block lg:hidden">
          {age.label}
        </span>
      </button>

      {showBundle && bundle ? (
        <button
          type="button"
          onClick={() => onOpenBundle(bundle.id)}
          className="hidden shrink-0 sm:block"
          aria-label={`Open ${bundle.name}`}
        >
          <Chip tone="neutral">{bundle.name}</Chip>
        </button>
      ) : null}

      <span className="hidden w-20 shrink-0 text-xs tabular-nums text-muted-foreground md:block">
        {formatFileSize(doc.size)}
      </span>
      <span
        className={cn(
          "hidden w-28 shrink-0 text-xs text-muted-foreground lg:block",
          age.stale && "text-amber-700 dark:text-amber-400",
        )}
      >
        {age.label}
      </span>
      <span className="hidden w-24 shrink-0 md:block">
        {doc.indexed ? (
          <span title={`${doc.chunkCount} ${doc.chunkCount === 1 ? "passage" : "passages"}`}>
            <Chip tone="on">Indexed</Chip>
          </span>
        ) : (
          <span title="No embeddings yet — no passage in it can be matched in chat.">
            <Chip tone="neutral">Not indexed</Chip>
          </span>
        )}
      </span>
      <span
        className="hidden w-20 shrink-0 text-xs tabular-nums text-muted-foreground xl:block"
        title="How many answers cite this document"
      >
        {citations > 0 ? citations : "—"}
      </span>

      <DocumentActions
        doc={doc}
        bundles={bundles}
        busy={busy.has(doc.id)}
        canWrite={canWrite}
        onOpen={onOpen}
        onMove={onMove}
        onReindex={onReindex}
        onRemove={onRemove}
      />
    </div>
  );
}

function DocumentGrid({ documents, ...actions }: RowActions & { documents: ExplorerDocument[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 xl:grid-cols-4">
      {documents.map((doc) => (
        <DocumentTile key={doc.id} doc={doc} {...actions} />
      ))}
    </div>
  );
}

function DocumentTile({
  doc,
  bundles,
  busy,
  canWrite,
  selected,
  onPick,
  onOpen,
  onMove,
  onReindex,
  onRemove,
}: RowActions & { doc: ExplorerDocument }) {
  const ticked = selected.has(doc.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: doc.id,
    disabled: !canWrite,
  });

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-hairline bg-background p-3 transition-colors hover:bg-surface-hover",
        ticked && "bg-surface-hover",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {canWrite ? (
            <Checkbox
              checked={ticked}
              onClick={(e) => onPick(doc.id, e.shiftKey)}
              aria-label={`Select ${doc.name}`}
            />
          ) : null}
          {/* The extension, not a thumbnail. A rendered preview of a document
              is a picture this component cannot actually produce, and a
              generic one dressed up as a preview is the first failure mode in
              DESIGN.md. It doubles as the grip, for the same reason the file
              icon does in the list: it is the one mark on the tile that is
              always there and is not already a control. */}
          {canWrite ? (
            <button
              ref={setNodeRef}
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Drag ${doc.name}`}
              title="Drag onto a bundle on the left to move it there"
              className="cursor-grab active:cursor-grabbing"
            >
              <Chip tone="code">{extensionLabel(doc.name)}</Chip>
            </button>
          ) : (
            <Chip tone="code">{extensionLabel(doc.name)}</Chip>
          )}
        </div>
        <DocumentActions
          doc={doc}
          bundles={bundles}
          busy={busy.has(doc.id)}
          canWrite={canWrite}
          onOpen={onOpen}
          onMove={onMove}
          onReindex={onReindex}
          onRemove={onRemove}
        />
      </div>
      <button
        type="button"
        onClick={() => onOpen(doc)}
        className="text-left text-[13px] font-medium leading-tight [overflow-wrap:anywhere]"
      >
        {doc.name}
      </button>
      {doc.routineId ? (
        <span className="truncate text-xs text-muted-foreground">
          Written by {doc.routineName ?? "a routine"}
        </span>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatFileSize(doc.size)}</span>
        {doc.indexed ? <Chip tone="on">Indexed</Chip> : <Chip tone="neutral">Not indexed</Chip>}
      </div>
    </div>
  );
}

function extensionLabel(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1].toUpperCase() : "FILE";
}

/**
 * Everything you can do to one document, in a menu.
 *
 * A menu rather than a row of icons, and the reason is the move: it needs a
 * list of every bundle, which does not fit on a row, and it has to be reachable
 * from the keyboard. Dragging the file onto a bundle in the rail does the same
 * thing faster under a pointer; this is the one that works without one.
 */
function DocumentActions({
  doc,
  bundles,
  busy,
  canWrite,
  onOpen,
  onMove,
  onReindex,
  onRemove,
}: {
  doc: ExplorerDocument;
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  busy: boolean;
  canWrite: boolean;
  onOpen: (d: ExplorerDocument) => void;
  onMove: (d: ExplorerDocument, bundleId: string) => void;
  onReindex: (d: ExplorerDocument) => void;
  onRemove: (d: ExplorerDocument) => void;
}) {
  const elsewhere = bundles.filter((b) => b.id !== doc.bundleId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        aria-label={`Actions for ${doc.name}`}
        disabled={busy}
      >
        {busy ? (
          <RefreshCw className="h-4 w-4 animate-spin" />
        ) : (
          <MoreVertical className="h-4 w-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onOpen(doc)}>
          <FileText className="mr-2 h-4 w-4" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void api.documents.download(doc.id, doc.name)}>
          <Download className="mr-2 h-4 w-4" />
          Download
        </DropdownMenuItem>
        {doc.externalUrl ? (
          <DropdownMenuItem asChild>
            <a href={doc.externalUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open at the source
            </a>
          </DropdownMenuItem>
        ) : null}

        {canWrite ? (
          <>
            <DropdownMenuSeparator />
            {elsewhere.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Move to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                  {elsewhere.map((b) => (
                    <DropdownMenuItem key={b.id} onSelect={() => onMove(doc, b.id)}>
                      <span className="truncate">{b.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem onSelect={() => onReindex(doc)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Reindex
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onRemove(doc)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where files come in.
 *
 * A drop target and a file picker in the same control, because a drop target
 * alone is a mechanism with no keyboard equivalent. It only accepts files when
 * a bundle is open: an upload has to know where it is going, and "everything
 * this agent reads" is a view rather than a place.
 */
function UploadWell({
  bundle,
  uploading,
  onFiles,
}: {
  bundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  uploading: Uploading[];
  onFiles: (files: FileList | File[] | null) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div className="border-t border-hairline p-4">
      <label
        onDragOver={(e) => {
          // Only for files from outside the page.
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed py-7 text-center transition-colors",
          dragging
            ? "border-accent-orange bg-surface-hover"
            : "border-border hover:bg-surface-hover",
        )}
      >
        <Upload
          className={cn("h-5 w-5", dragging ? "text-accent-orange" : "text-muted-foreground")}
        />
        <span className="font-dm text-[15px] font-medium">
          {bundle
            ? dragging
              ? "Drop to upload"
              : `Drop files into ${bundle.name}`
            : "Pick a bundle to upload into"}
        </span>
        <span className="text-xs text-muted-foreground">TXT, Markdown, CSV, JSON, PDF</span>
        <input
          type="file"
          multiple
          className="hidden"
          accept={ACCEPT}
          disabled={!bundle}
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = "";
            onFiles(files);
          }}
        />
      </label>

      {uploading.length > 0 ? (
        <div className="mt-3 space-y-2">
          {uploading.map((u) => (
            <div key={u.id} className="text-sm">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{u.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{u.progress}%</span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${u.progress}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
