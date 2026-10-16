import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  LayoutGrid,
  List,
  Lock,
  MoreVertical,
  Pencil,
  Presentation,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";

import { api } from "@/lib/api-client";
import { bundleDocumentsKey, useAgentsStore, type Agent } from "@/lib/agents-store";
import { indexingNow } from "@/lib/index-status";
import type { UploadPhase } from "@/lib/api-client";
import { canEditAgent } from "@/lib/agent-access";
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
import { ACCEPT, validateUpload } from "@/lib/uploads";
import { formatFileSize } from "@/lib/file-size";
import { dropPayload, rangeSelect } from "@/lib/knowledge-selection";
import { documentAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { filesFromDrop } from "@/lib/dropped-files";

type ExplorerDocument = Agent["documents"][number];

/**
 * What the pane is showing: the root, one folder, or everything an agent reads.
 *
 * `root` is the workspace page's front door — every folder, drawn as a folder,
 * the way a drive opens. `all` exists only in the agent context, where it is
 * the list this tab has always shown — every document in every attached
 * folder. It is a real question ("what does this agent know?") that no single
 * folder answers, so it stays, as the place the tab opens on.
 *
 * A "bundle" in the code is a folder on the screen. The word changed on the
 * screen because the screen now behaves like a file manager and a folder is
 * what a file manager has; it did not change in the code because the API, the
 * store and the tables all still say bundle.
 */
type Selection = { kind: "root" } | { kind: "all" } | { kind: "bundle"; id: string };

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

type Uploading = {
  id: string;
  name: string;
  progress: number;
  /** Waiting for a free slot, reading a PDF's text, or sending bytes. */
  phase: "waiting" | UploadPhase;
};

/**
 * How many files upload at once. Picking forty files used to start forty
 * requests together, which on an ordinary connection made every one of them
 * slow and the first finished no sooner than the last.
 */
const UPLOADS_AT_ONCE = 3;

/**
 * The Knowledge explorer: a file manager's window, for the workspace's files.
 *
 * Toolbar across the top (Back, the path, search, view, Upload), folders down
 * the side, the contents in the middle and a status line along the bottom.
 * The root shows the folders as folders; opening one shows its files. It is
 * laid out this way because it is the layout everybody already knows how to
 * walk around in, and the earlier version — a rail of names beside a table —
 * asked people to learn a screen for a thing they do every day on a desktop.
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
export function KnowledgeExplorer({
  agent,
  footer,
  className,
}: {
  agent?: Agent;
  /** The right-hand side of the status line: the workspace page's usage. */
  footer?: ReactNode;
  /** The window's own size, when the page wants it to fill the screen. */
  className?: string;
}) {
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
  /** Files from outside the page, held over the pane. */
  const [dropHover, setDropHover] = useState(false);

  const sensors = useSensors(
    // Six pixels of travel before a press becomes a drag, so pressing a row and
    // letting go still opens the file.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  // Derived rather than kept in sync by an effect: home is the answer until
  // somebody opens something, and a folder that has since been deleted falls
  // back to it rather than leaving the pane pointed at nothing.
  //
  // Home is the root on the workspace page and "everything it reads" in an
  // agent's tab — unless the agent reads nothing yet. That view cannot take an
  // upload (there is no one folder to put a file in), so an agent with no
  // documents opened on a pane whose only control was disabled. It opens on a
  // folder instead, an attached one first.
  const firstBundle = bundles.find((b) => agent?.bundleIds.includes(b.id)) ?? bundles[0] ?? null;
  const home: Selection = agent ? { kind: "all" } : { kind: "root" };
  const fallback: Selection =
    agent && agent.documents.length === 0 && firstBundle
      ? { kind: "bundle", id: firstBundle.id }
      : home;
  const selection: Selection =
    chosen && (chosen.kind !== "bundle" || bundles.some((b) => b.id === chosen.id))
      ? chosen
      : fallback;
  const atHome = selection.kind === home.kind;
  const openBundle =
    selection?.kind === "bundle" ? (bundles.find((b) => b.id === selection.id) ?? null) : null;

  // One bundle's contents. Not asked for at all while the agent's own list is
  // showing, which is the tab's opening state and needs no request of its own.
  const bundleDocuments = useQuery({
    queryKey: bundleDocumentsKey(openBundle?.id ?? ""),
    queryFn: () => api.bundles.documents(openBundle!.id),
    enabled: !!openBundle,
    // Indexing happens after the upload returns (`worker/src/lib/indexing`), so
    // a bundle with a document still in the queue asks again until none is.
    refetchInterval: (query) => ((query.state.data ?? []).some(indexingNow) ? 3_000 : false),
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

  // The root's folders, through the same search box the files use.
  const visibleFolders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...bundles]
      .filter((b) => !needle || b.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bundles, query]);

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
      toast.error("Pick a folder to upload into first.");
      return;
    }
    const bundleId = openBundle.id;
    const accepted: Array<{ id: string; file: File }> = [];
    for (const file of list) {
      const check = validateUpload(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      accepted.push({ id: `u_${crypto.randomUUID()}`, file });
    }
    if (accepted.length === 0) return;

    // The same name again in the same bundle is nearly always a new version of
    // a file, and two "pricing.pdf" side by side is how an agent ends up quoting
    // last year's. Asked once for the whole drop; Cancel keeps both.
    const already = new Map(
      (bundleDocuments.data ?? []).map((d) => [d.name.toLowerCase(), d] as const),
    );
    const repeats = accepted.filter(({ file }) => already.has(file.name.toLowerCase()));
    const replacing =
      repeats.length > 0 &&
      confirm(
        `${repeats.length === 1 ? `"${repeats[0].file.name}" is` : `${repeats.length} of these files are`} already in ${openBundle.name}. Replace ${repeats.length === 1 ? "it" : "them"} with the new upload? Cancel keeps both.`,
      );
    setUploading((prev) => [
      ...prev,
      ...accepted.map(({ id, file }) => ({
        id,
        name: file.name,
        progress: 0,
        phase: "waiting" as const,
      })),
    ]);
    const patch = (id: string, change: Partial<Uploading>) =>
      setUploading((prev) => prev.map((u) => (u.id === id ? { ...u, ...change } : u)));

    const uploadOne = async ({ id, file }: { id: string; file: File }) => {
      try {
        const doc = await store.uploadToBundle(
          bundleId,
          file,
          (pct) => patch(id, { progress: pct }),
          (phase) => patch(id, { phase }),
        );
        const previous = replacing ? already.get(file.name.toLowerCase()) : undefined;
        // Only once the new one is safely in: the old one goes to Recently
        // deleted, from where it can still come back.
        if (previous) await store.removeDocument(previous.id).catch(() => undefined);
        if (previous) {
          toast.success(`Replaced ${file.name} — indexing the new version`);
        } else if (doc.indexStatus === "queued" || doc.indexStatus === "indexing") {
          toast.success(`Added ${file.name} — indexing it now`);
        } else if (doc.indexed) {
          toast.success(`Added ${file.name}`);
        } else {
          toast.warning(
            `${file.name} went in but could not be indexed, so answers won't be grounded in it.`,
          );
        }
      } catch (err) {
        const message = (err as Error | undefined)?.message;
        toast.error(message ? `Upload failed: ${message}` : "Upload failed");
      } finally {
        setUploading((prev) => prev.filter((u) => u.id !== id));
      }
    };
    let next = 0;
    const lane = async () => {
      while (next < accepted.length) await uploadOne(accepted[next++]);
    };
    void Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, accepted.length) }, lane));
  };

  const moveMany = async (docs: ExplorerDocument[], bundleId: string) => {
    if (docs.length === 0) return;
    const where = bundles.find((b) => b.id === bundleId)?.name ?? "the folder";
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
        indexingNow(d)
          ? toast.success(`Reindexing ${doc.name} — its old passages answer until it finishes`)
          : toast.success(
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

  const loading = selection.kind === "bundle" && bundleDocuments.isPending;
  const bytes = documents.reduce((n, d) => n + d.size, 0);
  const canDrop = canWrite && !!openBundle;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDragging(String(e.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-xl border border-border bg-surface",
          className,
        )}
      >
        <Toolbar
          home={atHome}
          openBundle={openBundle}
          agent={agent}
          canWrite={canWrite}
          view={view}
          onView={setView}
          query={query}
          onQuery={setQuery}
          onHome={() => openFolder(home)}
          onFiles={addFiles}
        />

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <Sidebar
            bundles={bundles}
            agent={agent}
            selection={selection}
            onSelect={openFolder}
            canWrite={canWrite}
            dropping={!!dragging}
            readers={agent ? null : readersByBundle}
          />

          {/* The pane is the drop target, all of it: a file dragged in from
              the desktop can land anywhere on the folder that is open, the way
              it can in a file manager, and the strip at the foot says so. */}
          <section
            aria-label={
              openBundle ? openBundle.name : agent ? `Everything ${agent.name} reads` : "Folders"
            }
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            onDragOver={(e) => {
              if (!canDrop || !e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDropHover(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHover(false);
            }}
            onDrop={(e) => {
              if (!canDrop || !e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDropHover(false);
              // Read synchronously, inside the event: the entries are gone after it.
              void filesFromDrop(e.dataTransfer).then(addFiles);
            }}
          >
            {dropHover && openBundle ? (
              <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-lg border border-dashed border-brand bg-background/80">
                <span className="text-base font-semibold">
                  Drop to upload into {openBundle.name}
                </span>
              </div>
            ) : null}

            <PaneNotes
              openBundle={openBundle}
              canWrite={canWrite}
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

            <div className="min-h-0 flex-1 overflow-y-auto">
              {selection.kind === "root" ? (
                visibleFolders.length === 0 ? (
                  <div className="p-5">
                    <EmptyState
                      title={query ? "Nothing matches" : "No folders yet"}
                      description={
                        query
                          ? `No folder is called "${query}".`
                          : canWrite
                            ? "Make a folder, then drop the team's files into it. Each one is a place an agent can be pointed at."
                            : "Nobody has made a folder yet."
                      }
                    />
                  </div>
                ) : view === "grid" ? (
                  <FolderGrid
                    bundles={visibleFolders}
                    readers={readersByBundle}
                    onOpen={(id) => openFolder({ kind: "bundle", id })}
                  />
                ) : (
                  <FolderList
                    bundles={visibleFolders}
                    readers={readersByBundle}
                    onOpen={(id) => openFolder({ kind: "bundle", id })}
                  />
                )
              ) : loading ? (
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
                          ? `No file in this ${selection.kind === "all" ? "agent" : "folder"} is called "${query}".`
                          : selection.kind === "all"
                            ? "This agent has no folder attached, or the ones it has are empty. Pick a folder on the left and switch it on."
                            : canWrite
                              ? "Drop files here and they're chunked and embedded for retrieval in chat."
                              : "Nothing has been uploaded to this folder yet."
                    }
                  />
                </div>
              ) : view === "list" ? (
                <DocumentTable
                  documents={visible}
                  bundles={bundles}
                  showBundle={selection.kind === "all"}
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

              {/* The phone's "New folder", where the sidebar that holds it is
                  not shown. */}
              {selection.kind === "root" && canWrite ? (
                <div className="border-t border-hairline p-2 lg:hidden">
                  <NewFolderForm onCreated={(id) => openFolder({ kind: "bundle", id })} />
                </div>
              ) : null}
            </div>

            {canWrite && selection.kind !== "root" ? (
              <UploadStrip bundle={openBundle} uploading={uploading} onFiles={addFiles} />
            ) : null}

            {/* The status line: what is in front of you, counted, and — on the
                workspace page — the whole drive's usage beside it. */}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline bg-surface-muted px-4 py-1.5 text-xs text-muted-foreground">
              {selection.kind === "root" && footer ? (
                <span />
              ) : (
                <span>
                  {selection.kind === "root"
                    ? `${bundles.length} ${bundles.length === 1 ? "folder" : "folders"}`
                    : `${visible.length === documents.length ? documents.length : `${visible.length} of ${documents.length}`} ${documents.length === 1 ? "file" : "files"}${documents.length > 0 ? ` · ${formatFileSize(bytes)}` : ""}`}
                </span>
              )}
              {footer ? <span>{footer}</span> : null}
            </div>
          </section>
        </div>

        {previewing ? (
          <DocumentPreviewDialog
            documentId={previewing.id}
            name={previewing.name}
            onClose={() => setPreviewing(null)}
          />
        ) : null}
      </div>

      {/* What is in the hand while it is being dragged. Without it a drag is a
          row that dims and a sidebar that lights up, with nothing in between. */}
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
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-muted px-4 py-2 text-meta">
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
              <Folder className="mr-2 h-4 w-4" />
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

/* ------------------------------------------------------------- the sidebar */

/**
 * The folders, down the side, the way a file manager lists places.
 *
 * On the workspace page the first row is the root — every folder, as folders —
 * and the rows under it are the folders themselves. In an agent's tab the root
 * is "everything this agent reads" and the folders arrive in two groups, which
 * is the point of the tab: the top group is what the agent reads, the bottom is
 * everything else the workspace has, and the switch on each row is how one
 * moves between them. Grouping rather than hiding, because a sidebar filtered
 * down to the attached folders would be one with no way to attach the next.
 */
function Sidebar({
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
  /** Something is being dragged, so every folder says it will take it. */
  dropping: boolean;
  /**
   * Which agents read each folder, or null in an agent's own tab — there the
   * sidebar is already split into what this agent reads and what it does not,
   * and naming the others would answer a question the screen is not about.
   */
  readers: Record<string, string[]> | null;
}) {
  const store = useAgentsStore();
  const [railQuery, setRailQuery] = useState("");

  // A search rather than a "hide empty folders" switch, which was the other
  // way to make a long list shorter: the empty folder is the one somebody is
  // looking for, because it is the one waiting to be filled.
  const needle = railQuery.trim().toLocaleLowerCase();
  const matching = needle
    ? bundles.filter((b) => b.name.toLocaleLowerCase().includes(needle))
    : bundles;
  const attached = agent ? matching.filter((b) => agent.bundleIds.includes(b.id)) : matching;
  const detached = agent ? matching.filter((b) => !agent.bundleIds.includes(b.id)) : [];
  const total = bundles.reduce((n, b) => n + b.documentCount, 0);

  const row = (b: (typeof bundles)[number]) => (
    <FolderRow
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
  );

  return (
    <aside
      aria-label="Folders"
      className={cn(
        "flex w-full shrink-0 flex-col border-b border-hairline bg-surface-muted lg:w-60 lg:border-b-0 lg:border-r",
        // On a phone the workspace page navigates like a file manager does —
        // folders in the pane, Back in the toolbar — and the column would be
        // the same list twice. An agent's tab keeps it: the switches are here.
        !agent && "hidden lg:flex",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {agent ? (
          <PlaceRow
            icon={<HardDrive className="h-4 w-4" />}
            selected={selection?.kind === "all"}
            onClick={() => onSelect({ kind: "all" })}
            count={agent.documents.length}
          >
            Everything {agent.name} reads
          </PlaceRow>
        ) : (
          <PlaceRow
            icon={<HardDrive className="h-4 w-4" />}
            selected={selection?.kind === "root"}
            onClick={() => onSelect({ kind: "root" })}
            count={total}
          >
            Knowledge
          </PlaceRow>
        )}

        {bundles.length > RAIL_SEARCH_AFTER ? (
          <div className="relative px-2 pb-1 pt-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={railQuery}
              onChange={(e) => setRailQuery(e.target.value)}
              placeholder="Find a folder"
              aria-label="Find a folder by name"
              className="h-8 bg-background pl-8 text-meta"
            />
          </div>
        ) : null}

        {bundles.length === 0 ? (
          <p className="px-3 py-4 text-meta text-muted-foreground">
            No folders yet.{canWrite ? " Make the first one below." : ""}
          </p>
        ) : matching.length === 0 ? (
          <p className="px-3 py-4 text-meta text-muted-foreground">
            {`No folder is called "${railQuery.trim()}".`}
          </p>
        ) : (
          <>
            <SidebarHeading>{agent ? "Attached" : "Folders"}</SidebarHeading>
            {attached.length === 0 ? (
              <p className="px-3 py-2 text-meta text-muted-foreground">
                Nothing attached, so this agent reads nothing but its persona.
              </p>
            ) : (
              attached.map(row)
            )}
            {detached.length > 0 ? (
              <>
                <SidebarHeading>Not attached</SidebarHeading>
                {detached.map(row)}
              </>
            ) : null}
          </>
        )}
      </div>

      {canWrite ? (
        <div className="border-t border-hairline p-2">
          <NewFolderForm onCreated={(id) => onSelect({ kind: "bundle", id })} />
        </div>
      ) : null}
    </aside>
  );
}

/** A place that is not a folder: the root, or everything an agent reads. */
function PlaceRow({
  icon,
  selected,
  onClick,
  count,
  children,
}: {
  icon: ReactNode;
  selected: boolean;
  onClick: () => void;
  count: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "location" : undefined}
      className={cn(
        "mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-surface-hover font-medium" : "hover:bg-surface-hover",
      )}
    >
      <span className={cn("shrink-0", selected ? "text-brand" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </p>
  );
}

function FolderRow({
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

  const toggleShared = () => {
    const sharing = bundle.shared === false;
    const ask = sharing
      ? `Share "${bundle.name}" with the workspace? Everyone in it will be able to read its files, and the agents it is attached to will use it in their conversations too.`
      : `Stop sharing "${bundle.name}"? Only you will see its files, and agents will use it only in your own private conversations.`;
    if (!confirm(ask)) return;
    store
      .updateBundle(bundle.id, { shared: sharing })
      .then(() =>
        toast.success(sharing ? `Shared ${bundle.name}` : `${bundle.name} is only yours now`),
      )
      .catch((err) => toast.error(err?.message ?? "Could not change who sees it"));
  };

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
      <div className="px-2 py-1">
        <Input
          autoFocus
          value={draft}
          aria-label={`Rename ${bundle.name}`}
          className="h-8 bg-background"
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

  const unread = readers?.length === 0;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group mx-2 flex items-center gap-1 rounded-md pr-1 transition-colors",
        selected ? "bg-surface-hover" : "hover:bg-surface-hover",
        // Dashed while anything is in the air, so every place a file can land
        // says so; amber under the one it would land on now.
        dropping && "outline-dashed outline-1 outline-border",
        isOver && "bg-surface-hover outline outline-1 outline-brand",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${bundle.name}`}
        aria-current={selected ? "location" : undefined}
        title={
          [
            bundle.shared === false ? "Only you can see this folder." : null,
            unread ? "No agent reads this folder." : null,
            bundle.description,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-sm"
      >
        {selected ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-brand" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 fill-muted text-muted-foreground" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>
          {bundle.name}
        </span>
        {/* Said, not only drawn: the lock and the dot each carry their words
            for a screen reader, and the title above repeats them for a hover. */}
        {bundle.shared === false ? (
          <>
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">Only you</span>
          </>
        ) : null}
        {unread ? (
          <>
            {/* The one state worth a colour in a list of folders: a folder no
                agent has attached is one nothing can read out of. */}
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
            <span className="sr-only">no agent reads it</span>
          </>
        ) : null}
        <span className="shrink-0 pl-1 text-xs tabular-nums text-muted-foreground">
          {bundle.documentCount}
        </span>
      </button>

      {/* Attaching changes what the agent knows for everyone who uses it, so
          it takes Can edit on the agent (0104) — somebody who can only use it,
          or a viewer, sees the state and cannot change it. */}
      {agent ? (
        <Switch
          checked={agent.bundleIds.includes(bundle.id)}
          disabled={!canWrite || !canEditAgent(agent)}
          onCheckedChange={(on) =>
            on ? store.attachBundle(agent.id, bundle.id) : store.detachBundle(agent.id, bundle.id)
          }
          aria-label={`Attach ${bundle.name} to ${agent.name}`}
        />
      ) : null}

      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
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
            {/* Only its maker shares it or takes it back (0106). */}
            {bundle.mine ? (
              <DropdownMenuItem onSelect={() => toggleShared()}>
                {bundle.shared === false ? (
                  <Users className="mr-2 h-4 w-4" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                {bundle.shared === false ? "Share with the workspace" : "Stop sharing"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                if (
                  confirm(
                    `Delete "${bundle.name}"? Its files go with it and it detaches from every agent. It waits 30 days in Settings → Recently deleted, and restoring it brings the files back too.`,
                  )
                ) {
                  store.removeBundle(bundle.id);
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/**
 * "New folder": a row until it is pressed, then a name and a switch.
 *
 * Folded because a form that is always open is the heaviest thing in a
 * column of one-line rows, and most visits to this screen make no folder.
 */
function NewFolderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { createBundle } = useAgentsStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    createBundle(trimmed, undefined, shared)
      .then((bundle) => {
        setName("");
        setShared(false);
        setOpen(false);
        onCreated(bundle.id);
        toast.success(
          shared ? `Created ${bundle.name}, shared with the workspace` : `Created ${bundle.name}`,
        );
      })
      .catch((err) => toast.error(err?.message ? `Create failed: ${err.message}` : "Create failed"))
      .finally(() => setCreating(false));
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <FolderPlus className="h-4 w-4 shrink-0" />
        New folder
      </button>
    );
  }

  return (
    <div className="p-1">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          placeholder="Folder name"
          aria-label="Folder name"
          value={name}
          disabled={creating}
          className="h-8 bg-background"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
            if (e.key === "Escape") {
              setOpen(false);
              setName("");
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
      {/* Off by default (0106): a folder is its maker's until they share it. */}
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={shared}
          onCheckedChange={(on) => setShared(on === true)}
          aria-label="Share the new folder with the workspace"
        />
        Share with the workspace
      </label>
    </div>
  );
}

/* ------------------------------------------------------------- the content */

/**
 * The window's top edge: the way back, where you are, and the controls.
 *
 * Laid out the way a file manager lays out its toolbar — Back, then the path,
 * then search and view — because that arrangement is the one every reader
 * already knows how to use. The path is clickable: "Knowledge" is the root.
 */
function Toolbar({
  home,
  openBundle,
  agent,
  canWrite,
  view,
  onView,
  query,
  onQuery,
  onHome,
  onFiles,
}: {
  /** Whether the pane is showing the root (or, in an agent's tab, its list). */
  home: boolean;
  openBundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  agent?: Agent;
  canWrite: boolean;
  view: "list" | "grid";
  onView: (v: "list" | "grid") => void;
  query: string;
  onQuery: (q: string) => void;
  onHome: () => void;
  onFiles: (files: FileList | File[] | null) => void;
}) {
  const root = agent ? `Everything ${agent.name} reads` : "Knowledge";
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-2 py-2">
      <button
        type="button"
        onClick={onHome}
        disabled={home}
        aria-label="Back"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      <nav aria-label="Where you are" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        <button
          type="button"
          onClick={onHome}
          disabled={home}
          className={cn(
            "shrink-0 rounded-sm px-1 py-0.5 transition-colors",
            home
              ? "font-semibold text-foreground"
              : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
          )}
        >
          {root}
        </button>
        {openBundle ? (
          <>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 items-center gap-1.5 px-1 font-semibold">
              <span className="truncate">{openBundle.name}</span>
              {openBundle.shared === false ? (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Only you" />
              ) : null}
            </span>
          </>
        ) : null}
      </nav>

      <div className="relative hidden w-56 sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={
            openBundle
              ? `Search in ${openBundle.name}`
              : home && !agent
                ? "Search folders"
                : "Search files"
          }
          aria-label="Search files by name"
          className="h-8 bg-background pl-8 text-meta"
        />
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-hairline p-0.5">
        <ViewButton active={view === "list"} onClick={() => onView("list")} label="List view">
          <List className="h-4 w-4" />
        </ViewButton>
        <ViewButton active={view === "grid"} onClick={() => onView("grid")} label="Grid view">
          <LayoutGrid className="h-4 w-4" />
        </ViewButton>
      </div>

      {canWrite && openBundle ? (
        <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm font-medium transition-colors hover:bg-surface-hover">
          <Upload className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Upload</span>
          <input
            type="file"
            multiple
            className="hidden"
            accept={ACCEPT}
            aria-label={`Upload files into ${openBundle.name}`}
            onChange={(e) => {
              // Copied before the reset — see the strip at the foot of the pane.
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              onFiles(files);
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

/**
 * The line under the toolbar, when there is something to say: who reads the
 * open folder, the filters that would find something, and what a viewer may
 * not do. Nothing at all otherwise — the toolbar sits straight on the files.
 */
function PaneNotes({
  openBundle,
  canWrite,
  filter,
  onFilter,
  tallies,
  readers,
}: {
  openBundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  canWrite: boolean;
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  tallies: { unindexed: number; stale: number };
  /**
   * The agents that read the open folder, or null in an agent's own tab, where
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
  const viewerNote = openBundle && !canWrite;
  if (!readers && chips.length === 0 && !viewerNote) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-hairline px-4 py-2 text-meta text-muted-foreground">
      {/* Who can actually retrieve what is in here. A folder nobody has
          attached is a folder of files no answer can ever stand on, and the
          count in the sidebar says nothing about that. */}
      {readers ? (
        <span>
          {readers.length === 0
            ? "No agent reads this folder yet — attach it from an agent's Knowledge tab."
            : `Read by ${listOf(readers)}.`}
        </span>
      ) : null}
      {viewerNote ? (
        <span>
          You can read everything here. Uploading, moving and deleting are a member's job.
        </span>
      ) : null}
      {chips.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
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
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the folders */

/**
 * The root: every folder, as a folder.
 *
 * This is the view that makes the screen a file system rather than a list
 * with a sidebar. Opening the page shows what there is to open, the way a
 * drive does, and a folder is a thing you go into rather than a filter you
 * apply. Both views share the sort the files use — by name — and the search
 * box above narrows them by name too.
 */
function FolderGrid({
  bundles,
  readers,
  onOpen,
}: {
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  readers: Record<string, string[]> | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 p-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {bundles.map((b) => (
        <FolderTile
          key={b.id}
          bundle={b}
          readers={readers ? (readers[b.id] ?? []) : undefined}
          onOpen={() => onOpen(b.id)}
        />
      ))}
    </div>
  );
}

function FolderTile({
  bundle,
  readers,
  onOpen,
}: {
  bundle: ReturnType<typeof useAgentsStore>["bundles"][number];
  readers: string[] | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${bundle.name}`}
      title={bundle.description ?? undefined}
      className="flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-center transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      <span className="relative">
        <Folder className="h-12 w-12 fill-muted text-muted-foreground" strokeWidth={1.25} />
        {bundle.shared === false ? (
          <Lock
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-surface p-0.5 text-foreground"
            aria-label="Only you"
          />
        ) : null}
      </span>
      <span className="line-clamp-2 w-full text-meta font-medium leading-tight [overflow-wrap:anywhere]">
        {bundle.name}
      </span>
      <span className="text-xs text-muted-foreground">
        {bundle.documentCount} {bundle.documentCount === 1 ? "file" : "files"}
        {readers && readers.length === 0 ? " · no agent" : ""}
      </span>
    </button>
  );
}

function FolderList({
  bundles,
  readers,
  onOpen,
}: {
  bundles: ReturnType<typeof useAgentsStore>["bundles"];
  readers: Record<string, string[]> | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className="hidden items-center gap-3 border-b border-hairline px-5 py-2 text-xs text-muted-foreground md:flex">
        <span className="w-4 shrink-0" />
        <span className="flex-1">Name</span>
        <span className="w-20 shrink-0">Files</span>
        {readers ? <span className="hidden w-40 shrink-0 lg:block">Read by</span> : null}
        <span className="w-28 shrink-0">Created</span>
      </div>
      <div className="divide-y divide-hairline">
        {bundles.map((b) => {
          const who = readers?.[b.id];
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onOpen(b.id)}
              aria-label={`Open ${b.name}`}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover"
            >
              <Folder className="h-4 w-4 shrink-0 fill-muted text-muted-foreground" />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate">{b.name}</span>
                {b.shared === false ? (
                  <>
                    <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="sr-only">Only you</span>
                  </>
                ) : null}
                {b.description ? (
                  <span className="hidden truncate text-xs text-muted-foreground md:inline">
                    · {b.description}
                  </span>
                ) : null}
              </span>
              <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">
                {b.documentCount} {b.documentCount === 1 ? "file" : "files"}
              </span>
              {readers ? (
                <span
                  className={cn(
                    "hidden w-40 shrink-0 truncate text-xs text-muted-foreground lg:block",
                    who && who.length === 0 && "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {who && who.length > 0 ? listOf(who) : "No agent"}
                </span>
              ) : null}
              <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block">
                {b.createdAt ? documentAge(b.createdAt).label : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The mark a file wears, from its name. A kind, not a thumbnail: a rendered
 * preview of a document is a picture this component cannot produce, and a
 * generic one dressed up as a preview is the first failure mode in DESIGN.md.
 */
function FileIcon({ doc, className }: { doc: ExplorerDocument; className?: string }) {
  const ext = doc.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (doc.externalUrl || /^https?:\/\//i.test(doc.name)) return <Globe className={className} />;
  if (["xlsx", "xls", "csv", "tsv", "numbers"].includes(ext))
    return <FileSpreadsheet className={className} />;
  if (["pptx", "ppt", "key"].includes(ext)) return <Presentation className={className} />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext))
    return <FileImage className={className} />;
  if (["json", "js", "ts", "tsx", "py", "html", "css", "xml", "yaml", "yml"].includes(ext))
    return <FileCode className={className} />;
  return <FileText className={className} />;
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
        "flex items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface-hover",
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
          title="Drag onto a folder on the left to move it there"
          className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <FileIcon doc={doc} className="h-4 w-4" />
        </button>
      ) : (
        <FileIcon doc={doc} className="h-4 w-4 shrink-0 text-muted-foreground" />
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
        <IndexChip doc={doc} />
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
      {/* A kind and an extension, not a thumbnail — see FileIcon. The icon
          doubles as the grip, for the same reason it does in the list: it is
          the one mark on the tile that is always there and is not already a
          control. */}
      {canWrite ? (
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${doc.name}`}
          title="Drag onto a folder on the left to move it there"
          className="flex cursor-grab flex-col items-center gap-1 self-center active:cursor-grabbing"
        >
          <FileIcon doc={doc} className="h-10 w-10 text-muted-foreground" />
          <Chip tone="code">{doc.externalUrl ? "WEB" : extensionLabel(doc.name)}</Chip>
        </button>
      ) : (
        <span className="flex flex-col items-center gap-1 self-center">
          <FileIcon doc={doc} className="h-10 w-10 text-muted-foreground" />
          <Chip tone="code">{doc.externalUrl ? "WEB" : extensionLabel(doc.name)}</Chip>
        </span>
      )}
      <button
        type="button"
        onClick={() => onOpen(doc)}
        aria-label={`Open ${doc.name}`}
        className="line-clamp-2 text-center text-meta font-medium leading-tight [overflow-wrap:anywhere]"
      >
        {doc.name}
      </button>
      {doc.routineId ? (
        <span className="truncate text-center text-xs text-muted-foreground">
          Written by {doc.routineName ?? "a routine"}
        </span>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatFileSize(doc.size)}</span>
        <IndexChip doc={doc} />
      </div>
    </div>
  );
}

function extensionLabel(name: string): string {
  if (/^https?:\/\//i.test(name)) return "WEB";
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
  const queryClient = useQueryClient();

  const resync = async () => {
    try {
      await api.documents.resync(doc.id);
      toast.success(`${doc.name} will be synced in the next minute or two`);
    } catch (err) {
      toast.error((err as Error)?.message ?? "Could not sync it");
    }
  };

  const rename = async () => {
    const next = window.prompt(`Rename ${doc.name}`, doc.name)?.trim();
    if (!next || next === doc.name) return;
    try {
      await api.documents.rename(doc.id, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bundle-documents"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]);
      toast.success(`Renamed to ${next}`);
    } catch (err) {
      toast.error((err as Error)?.message ?? "Rename failed");
    }
  };

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
            {/* A synced file's name is its source's; the next sync would undo it. */}
            {!doc.connectionId ? (
              <DropdownMenuItem onSelect={() => void rename()}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
            ) : null}
            {doc.connectionId ? (
              <DropdownMenuItem onSelect={() => void resync()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync now
              </DropdownMenuItem>
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
 * A web page, as a document. The server fetches it — a browser could not read
 * most sites from here anyway — keeps the HTML and indexes its text. A
 * snapshot: adding the page again later is how it is refreshed.
 */
function AddWebPage({ bundleId }: { bundleId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const url = window.prompt("The address of the page to add")?.trim();
    if (!url) return;
    setBusy(true);
    try {
      const doc = await api.bundles.addUrl(bundleId, url);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bundle-documents"] }),
        queryClient.invalidateQueries({ queryKey: ["bundles"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]);
      toast.success(`Added ${doc.name} — indexing it now`);
    } catch (err) {
      toast.error((err as Error)?.message ?? "Could not add that page");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void add()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 hover:text-foreground disabled:opacity-50"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {busy ? "Fetching the page…" : "Add a web page"}
    </button>
  );
}

/**
 * Where files come in, said at the foot of the pane.
 *
 * The pane itself is the drop target (see the section in the explorer), so
 * this is the sentence that says so plus the two ways in that a drop cannot
 * do: a file picker, which is the keyboard's equivalent, and a web page. A
 * strip rather than a well, because a well the height of six rows under
 * every folder was the biggest thing on a screen that is about the files.
 *
 * Files only go into a folder: an upload has to know where it is going, and
 * "everything this agent reads" is a view rather than a place.
 */
function UploadStrip({
  bundle,
  uploading,
  onFiles,
}: {
  bundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  uploading: Uploading[];
  onFiles: (files: FileList | File[] | null) => void;
}) {
  return (
    <div className="border-t border-hairline px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Upload className="h-3.5 w-3.5" />
          {bundle ? (
            <>
              <span>Drop files into {bundle.name}</span>
              <span>or</span>
              <label className="cursor-pointer underline underline-offset-2 hover:text-foreground">
                choose files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept={ACCEPT}
                  onChange={(e) => {
                    // Copied before the reset, not after. Clearing `value`
                    // empties the very FileList `e.target.files` returned,
                    // in Chromium at least, so the picker handed over
                    // nothing and the upload never started.
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    onFiles(files);
                  }}
                />
              </label>
            </>
          ) : (
            <span>Pick a folder to upload into</span>
          )}
        </span>
        {bundle ? (
          <>
            {/* A folder picker of its own: the same input cannot pick both
                files and folders, and the drop target already takes both. */}
            <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
              <FolderOpen className="h-3.5 w-3.5" />
              Upload a folder
              <input
                type="file"
                multiple
                className="hidden"
                aria-label="Upload a folder"
                {...({ webkitdirectory: "" } as Record<string, string>)}
                onChange={(e) => {
                  // Copied before the reset: clearing `value` empties the very
                  // FileList `e.target.files` returned, in Chromium at least.
                  const files = Array.from(e.target.files ?? []).filter(
                    (f) => !f.name.startsWith("."),
                  );
                  e.target.value = "";
                  onFiles(files);
                }}
              />
            </label>
            <AddWebPage bundleId={bundle.id} />
            <span className="hidden xl:inline">
              PDF, Word, PowerPoint, Excel, Markdown, text and more · up to 100 MB each
            </span>
          </>
        ) : null}
      </div>

      {uploading.length > 0 ? (
        <div className="mt-2 space-y-2">
          {uploading.map((u) => (
            <div key={u.id} className="text-sm">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{u.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {u.phase === "waiting"
                    ? "Waiting…"
                    : u.phase === "reading"
                      ? "Reading the PDF…"
                      : `${u.progress}%`}
                </span>
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

/**
 * Where a document's indexing has got, in one chip.
 *
 * Queued and indexing are new: an upload now returns before its passages are
 * embedded (`worker/src/lib/indexing`), so "Not indexed" would be the wrong
 * thing to say about a file that will be searchable in a minute. Failed says
 * why on hover and is fixed the way it always was, with Reindex. Partly
 * indexed is a document longer than the indexing limit: everything up to the
 * cut is searchable and nothing after it is.
 */
function IndexChip({ doc }: { doc: ExplorerDocument }) {
  const passages = `${doc.chunkCount} ${doc.chunkCount === 1 ? "passage" : "passages"}`;
  switch (doc.indexStatus) {
    case "queued":
      return (
        <span title="Waiting to be read and indexed.">
          <Chip tone="neutral">Queued</Chip>
        </span>
      );
    case "indexing": {
      const p = doc.indexProgress;
      const pct = p && p.total > 0 ? Math.min(99, Math.round((p.done / p.total) * 100)) : null;
      return (
        <span title="Being indexed. Until it finishes, any passages it had before still answer.">
          <Chip tone="neutral">{pct === null ? "Indexing…" : `Indexing ${pct}%`}</Chip>
        </span>
      );
    }
    case "failed":
      return (
        <span title={doc.indexError ?? "Indexing failed. Reindex to try again."}>
          <Chip tone="neutral" className="text-destructive">
            Failed
          </Chip>
        </span>
      );
    case "partial":
      return (
        <span
          title={`${passages}. The document is longer than the indexing limit, so only its first part is searchable.`}
        >
          <Chip tone="on">Partly indexed</Chip>
        </span>
      );
    default:
      return doc.indexed ? (
        <span title={passages}>
          <Chip tone="on">Indexed</Chip>
        </span>
      ) : (
        <span title="No embeddings yet — no passage in it can be matched in chat.">
          <Chip tone="neutral">Not indexed</Chip>
        </span>
      );
  }
}
