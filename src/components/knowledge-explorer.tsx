import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
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
  Bot,
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
  MoreHorizontal,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";

import { lookup, msg, useTranslation, type Translate } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { api } from "@/lib/api-client";
import { bundleDocumentsKey, useAgentsStore, type Agent } from "@/lib/agents-store";
import { indexingNow } from "@/lib/index-status";
import type { UploadPhase } from "@/lib/api-client";
import { canEditAgent } from "@/lib/agent-access";
import { Chip } from "@/components/chip";
import { DocumentPreviewDialog } from "@/components/document-preview-dialog";
import { FolderReadersDialog } from "@/components/folder-readers-dialog";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { TopBar } from "@/components/top-bar";
import { StatusDot } from "@/components/status-dot";
import { Tile } from "@/components/tile";
import { Avatar } from "@/components/avatar";
import { EmptyWell } from "@/components/empty-page";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useConnections } from "@/hooks/use-connections";
import { agoShort, lastActivityLabel } from "@/lib/day-groups";
import { shortName } from "@/lib/monogram";
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
import { ACCEPT, validateUpload, acceptedSummary } from "@/lib/uploads";
import { formatFileSize } from "@/lib/file-size";
import { dropPayload, rangeSelect } from "@/lib/knowledge-selection";
import { documentAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { folderDescription } from "@/lib/reports";
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

/**
 * What an empty pane says when a filter found nothing, with and without a
 * search — whole sentences, so each language can put the filter where it goes.
 */
const FILTER_EMPTY: Record<Exclude<FilterKey, "all">, { searched: string; plain: string }> = {
  unindexed: {
    searched: msg(
      'No file called "{{query}}" is waiting to be indexed. Press All to see every file again.',
    ),
    plain: msg("Nothing here is waiting to be indexed. Press All to see every file again."),
  },
  stale: {
    searched: msg(
      'No file called "{{query}}" is older than ninety days. Press All to see every file again.',
    ),
    plain: msg("Nothing here is older than ninety days. Press All to see every file again."),
  },
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
  chrome = "embedded",
  footer,
  className,
}: {
  agent?: Agent;
  /**
   * `page` on /knowledge (A6): the explorer draws the page's own bar and fills
   * the window under it. `embedded` inside an agent's tab, in a box.
   */
  chrome?: "page" | "embedded";
  /** The right-hand side of the status line: the workspace page's usage. */
  footer?: ReactNode;
  /** The window's own size, when the page wants it to fill the screen. */
  className?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
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

  /**
   * Attaching a folder to an agent, from here.
   *
   * Only on the workspace page — the agent's own tab has the Switch beside
   * every folder — and only for somebody who can edit at least one agent,
   * since attaching takes Can edit (0104). A tester uploaded a file here,
   * asked the agent about it, and could not find the screen that would have
   * made the agent read it; the upload toast, the folder's menu and the strip
   * above its files now all lead to the same dialog.
   */
  const editableAgents = useMemo(() => store.agents.filter(canEditAgent), [store.agents]);
  const [attaching, setAttaching] = useState<(typeof bundles)[number] | null>(null);
  const onAttach =
    !agent && editableAgents.length > 0 ? (b: (typeof bundles)[number]) => setAttaching(b) : null;

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
    const needle = query.trim().toLocaleLowerCase(locale);
    const filtered = documents.filter((d) => {
      if (needle && !d.name.toLocaleLowerCase(locale).includes(needle)) return false;
      if (filter === "unindexed") return !d.indexed;
      if (filter === "stale") return documentAge(d.createdAt).stale;
      return true;
    });
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => factor * compare(a, b, sort.key, counts, locale));
  }, [documents, query, filter, sort, counts, locale]);

  // The root's folders, through the same search box the files use.
  const visibleFolders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return [...bundles]
      .filter((b) => !needle || b.name.toLocaleLowerCase(locale).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [bundles, query, locale]);

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
      toast.error(t("Pick a folder to upload into first."));
      return;
    }
    const bundleId = openBundle.id;
    const accepted: Array<{ id: string; file: File }> = [];
    for (const file of list) {
      const check = validateUpload(file, t);
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
      (bundleDocuments.data ?? []).map((d) => [d.name.toLocaleLowerCase(locale), d] as const),
    );
    const repeats = accepted.filter(({ file }) => already.has(file.name.toLocaleLowerCase(locale)));
    const replacing =
      repeats.length > 0 &&
      confirm(
        // One plural key: the singular names the file, the plural counts them.
        t(
          '"{{file}}" is already in {{folder}}. Replace it with the new upload? Cancel keeps both.',
          {
            count: repeats.length,
            file: repeats[0].file.name,
            folder: openBundle.name,
            defaultValue_other:
              "{{count}} of these files are already in {{folder}}. Replace them with the new upload? Cancel keeps both.",
          },
        ),
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

    // The next step, on the toast, when the folder these went into is one no
    // agent reads: a file nobody has attached cannot ground an answer, and the
    // page that says so is not the one the person is on. Once per drop, so a
    // ten-file upload does not raise ten offers. Twelve seconds, as the invite
    // toast gives its action: one nobody has time to read is no action at all.
    const folder = openBundle;
    let offered = false;
    const attachOffer = (): Parameters<typeof toast.success>[1] | undefined => {
      if (agent || offered || (readersByBundle[bundleId] ?? []).length > 0) return undefined;
      if (editableAgents.length === 0) return undefined;
      offered = true;
      if (editableAgents.length === 1) {
        const a = editableAgents[0];
        return {
          duration: 12000,
          action: {
            label: t("Attach to {{agent}}", { agent: a.name }),
            onClick: () =>
              void Promise.resolve(store.attachBundle(a.id, bundleId)).then((ok) => {
                if (ok)
                  toast.success(
                    t("{{folder}} is now read by {{agent}}", {
                      folder: folder.name,
                      agent: a.name,
                    }),
                  );
              }),
          },
        };
      }
      return {
        duration: 12000,
        action: { label: t("Choose agents"), onClick: () => setAttaching(folder) },
      };
    };
    const added = (message: string) => {
      const offer = attachOffer();
      return offer ? toast.success(message, offer) : toast.success(message);
    };

    const uploadOne = async ({ id, file }: { id: string; file: File }) => {
      try {
        const doc = await store.uploadToBundle(
          bundleId,
          file,
          (pct) => patch(id, { progress: pct }),
          (phase) => patch(id, { phase }),
        );
        const previous = replacing ? already.get(file.name.toLocaleLowerCase(locale)) : undefined;
        // Only once the new one is safely in: the old one goes to Recently
        // deleted, from where it can still come back.
        if (previous) await store.removeDocument(previous.id).catch(() => undefined);
        if (previous) {
          toast.success(t("Replaced {{file}} — indexing the new version", { file: file.name }));
        } else if (doc.indexStatus === "queued" || doc.indexStatus === "indexing") {
          added(t("Added {{file}} — indexing it now", { file: file.name }));
        } else if (doc.indexed) {
          added(t("Added {{file}}", { file: file.name }));
        } else {
          toast.warning(
            t("{{file}} went in but could not be indexed, so answers won't be grounded in it.", {
              file: file.name,
            }),
          );
        }
      } catch (err) {
        const message = (err as Error | undefined)?.message;
        toast.error(
          message ? t("Upload failed: {{reason}}", { reason: message }) : t("Upload failed"),
        );
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
    const where = bundles.find((b) => b.id === bundleId)?.name ?? t("the folder");
    setMoved((prev) => ({ ...prev, ...Object.fromEntries(docs.map((d) => [d.id, bundleId])) }));
    const outcome = await eachInTurn(t, docs, {
      progress: (done, total) =>
        t("Moving {{done}} of {{total}} to {{folder}}…", { done, total, folder: where }),
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
    announce(t, outcome, {
      one: (name) => t("Moved {{file}} to {{folder}}", { file: name, folder: where }),
      many: (n) =>
        t("Moved {{count}} file to {{folder}}", {
          count: n,
          folder: where,
          defaultValue_other: "Moved {{count}} files to {{folder}}",
        }),
      failed: (reason) => t("Move failed: {{reason}}", { reason }),
      partial: (n, total) =>
        t("Moved {{done}} of {{total}} to {{folder}}.", { done: n, total, folder: where }),
    });
  };

  const move = (doc: ExplorerDocument, bundleId: string) => void moveMany([doc], bundleId);

  const reindex = (doc: ExplorerDocument) => {
    markBusy(doc.id, true);
    store
      .reindexDocument(doc.id)
      .then((d) =>
        indexingNow(d)
          ? toast.success(
              t("Reindexing {{file}} — its old passages answer until it finishes", {
                file: doc.name,
              }),
            )
          : toast.success(
              t("Reindexed {{file}} — {{count}} passage", {
                file: doc.name,
                count: d.chunkCount,
                defaultValue_other: "Reindexed {{file}} — {{count}} passages",
              }),
            ),
      )
      .catch((err) =>
        toast.error(
          err?.message
            ? t("Reindex failed: {{reason}}", { reason: err.message })
            : t("Reindex failed"),
        ),
      )
      .finally(() => markBusy(doc.id, false));
  };

  const removeMany = async (docs: ExplorerDocument[]) => {
    if (docs.length === 0) return;
    const ask = t('Delete "{{file}}"? They wait 30 days in Settings → Recently deleted.', {
      count: docs.length,
      file: docs[0].name,
      defaultValue_other:
        "Delete {{count}} files? They wait 30 days in Settings → Recently deleted.",
    });
    if (!confirm(ask)) return;
    const outcome = await eachInTurn(t, docs, {
      progress: (done, total) => t("Deleting {{done}} of {{total}}…", { done, total }),
      run: (doc) => store.removeDocument(doc.id),
      onStart: (doc) => markBusy(doc.id, true),
      onSettled: (doc) => markBusy(doc.id, false),
    });
    setSelected((prev) => {
      const next = new Set(prev);
      for (const doc of docs) next.delete(doc.id);
      return next;
    });
    announce(t, outcome, {
      one: (name) => t("Deleted {{file}}", { file: name }),
      many: (n) =>
        t("Deleted {{count}} file", { count: n, defaultValue_other: "Deleted {{count}} files" }),
      failed: (reason) => t("Delete failed: {{reason}}", { reason }),
      partial: (n, total) => t("Deleted {{done}} of {{total}}.", { done: n, total }),
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

  const page = chrome === "page" && !agent;
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
          page
            ? "flex min-h-0 flex-1 flex-col bg-background"
            : "flex flex-col overflow-hidden rounded-xl border border-border bg-surface",
          className,
        )}
      >
        {page ? (
          <KnowledgeTopBar
            openBundle={openBundle}
            home={atHome}
            canWrite={canWrite}
            view={view}
            onView={setView}
            query={query}
            onQuery={setQuery}
            onHome={() => openFolder(home)}
            onFiles={addFiles}
            onCreated={(id) => openFolder({ kind: "bundle", id })}
          />
        ) : (
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
        )}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <Sidebar
            page={page}
            openName={openBundle?.name ?? null}
            bundles={bundles}
            agent={agent}
            selection={selection}
            onSelect={openFolder}
            canWrite={canWrite}
            dropping={!!dragging}
            readers={agent ? null : readersByBundle}
            onAttach={onAttach}
          />

          {/* The pane is the drop target, all of it: a file dragged in from
              the desktop can land anywhere on the folder that is open, the way
              it can in a file manager, and the strip at the foot says so. */}
          <section
            aria-label={
              openBundle
                ? openBundle.name
                : agent
                  ? t("Everything {{agent}} reads", { agent: agent.name })
                  : t("Folders")
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
              <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-lg border border-dashed border-foreground/40 bg-background/80">
                <span className="text-base font-semibold">
                  {t("Drop to upload into {{folder}}", { folder: openBundle.name })}
                </span>
              </div>
            ) : null}

            <PaneNotes
              openBundle={openBundle}
              canWrite={canWrite}
              filter={filter}
              onFilter={setFilter}
              tallies={tallies}
              readers={
                agent || !openBundle
                  ? null
                  : page && (readersByBundle[openBundle.id] ?? []).length > 0
                    ? null
                    : (readersByBundle[openBundle.id] ?? [])
              }
              onAttach={onAttach && openBundle ? () => onAttach(openBundle) : null}
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
                    <EmptyWell
                      title={query ? t("Nothing matches") : t("No folders yet")}
                      description={
                        query
                          ? t('No folder is called "{{query}}".', { query })
                          : canWrite
                            ? t(
                                "Make a folder, then drop the team's files into it. Each one is a place an agent can be pointed at.",
                              )
                            : t("Nobody has made a folder yet.")
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
                <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                  {t("Loading…")}
                </p>
              ) : page && openBundle && canWrite && documents.length === 0 && !query ? (
                // An empty folder (A24): a well to drop into, and the two ways
                // to fill it otherwise.
                <div className="grid place-items-center p-10">
                  <EmptyWell
                    className="w-full max-w-[420px]"
                    title={t("Drop files here")}
                    description={t(
                      "{{formats}}. Agents that read this folder see them within a minute.",
                      { formats: acceptedSummary(t) },
                    )}
                    actions={
                      <>
                        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
                          <Upload className="size-4" />
                          {t("Upload")}
                          <input
                            type="file"
                            multiple
                            className="sr-only"
                            accept={ACCEPT}
                            aria-label={t("Upload files into {{folder}}", {
                              folder: openBundle.name,
                            })}
                            onChange={(e) => {
                              const files = Array.from(e.target.files ?? []);
                              e.target.value = "";
                              void addFiles(files);
                            }}
                          />
                        </label>
                        <Button asChild variant="secondary">
                          <Link to="/settings/integrations">{t("Connect Google Drive")}</Link>
                        </Button>
                      </>
                    }
                  />
                </div>
              ) : visible.length === 0 ? (
                <div className="p-5">
                  <EmptyWell
                    title={query || filter !== "all" ? t("Nothing matches") : t("Nothing here yet")}
                    description={
                      // The filter before the search, because a filter left on from
                      // another folder is the one an empty pane does not explain by
                      // itself.
                      filter !== "all"
                        ? query
                          ? lookup(t, FILTER_EMPTY[filter].searched, { query })
                          : lookup(t, FILTER_EMPTY[filter].plain)
                        : query
                          ? selection.kind === "all"
                            ? t('No file in this agent is called "{{query}}".', { query })
                            : t('No file in this folder is called "{{query}}".', { query })
                          : selection.kind === "all"
                            ? t(
                                "This agent has no folder attached, or the ones it has are empty. Pick a folder on the left and switch it on.",
                              )
                            : canWrite
                              ? t(
                                  "Drop files here and they're chunked and embedded for retrieval in chat.",
                                )
                              : t("Nothing has been uploaded to this folder yet.")
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
                  readers={readersByBundle}
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

            {/* The status line (A6): what is in front of you, counted; when the
                open folder last synced; who reads it — and, on the root, the
                whole drive's usage. */}
            <div
              className={cn(
                "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline text-xs text-muted-foreground",
                page ? "min-h-9 px-6 py-1.5" : "bg-surface-muted px-4 py-1.5",
              )}
            >
              {selection.kind === "root" && footer ? null : (
                <span>
                  {selection.kind === "root"
                    ? t("{{count}} folder", {
                        count: bundles.length,
                        defaultValue_other: "{{count}} folders",
                      })
                    : [
                        visible.length === documents.length
                          ? t("{{count}} file", {
                              count: documents.length,
                              defaultValue_other: "{{count}} files",
                            })
                          : t("{{shown}} of {{count}} file", {
                              shown: visible.length,
                              count: documents.length,
                              defaultValue_other: "{{shown}} of {{count}} files",
                            }),
                        documents.length > 0 ? formatFileSize(bytes, locale) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              )}
              {page && openBundle ? <FolderSync bundleId={openBundle.id} /> : null}
              {page && openBundle ? (
                <span className="ml-auto">
                  {(() => {
                    const n = (readersByBundle[openBundle.id] ?? []).length;
                    return n === 0
                      ? t("Used by no agent")
                      : t("Used by {{count}} agent", {
                          count: n,
                          defaultValue_other: "Used by {{count}} agents",
                        });
                  })()}
                </span>
              ) : null}
              {footer && selection.kind === "root" ? <span>{footer}</span> : null}
            </div>
          </section>
        </div>

        <FolderReadersDialog
          bundle={attaching}
          onOpenChange={(open) => {
            if (!open) setAttaching(null);
          }}
        />
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
              {draggedCount > 1
                ? t("{{count}} file", {
                    count: draggedCount,
                    defaultValue_other: "{{count}} files",
                  })
                : draggedName}
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
  locale: string,
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
      return a.name.localeCompare(b.name, locale);
  }
}

/* ------------------------------------------------------- acting on a batch */

type Outcome = { ok: string[]; failed: { name: string; reason: string }[] };

function reasonOf(err: unknown, t: Translate): string {
  const message = err instanceof Error ? err.message : "";
  return message || t("something went wrong");
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
  t: Translate,
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
      outcome.failed.push({ name: doc.name, reason: reasonOf(err, t) });
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
  t: Translate,
  outcome: Outcome,
  words: {
    one: (name: string) => string;
    many: (n: number) => string;
    /** "Move failed: …" — the whole sentence, since the verb's place in it is the language's. */
    failed: (reason: string) => string;
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
    toast.error(words.failed(first.reason));
    return;
  }
  const summary = words.partial(outcome.ok.length, total);
  toast.error(
    rest.length > 0
      ? t("{{summary}} {{file}} — {{reason}} And {{count}} more failed.", {
          summary,
          file: first.name,
          reason: first.reason,
          count: rest.length,
          defaultValue_other: "{{summary}} {{file}} — {{reason}} And {{count}} more failed.",
        })
      : t("{{summary}} {{file}} — {{reason}}", {
          summary,
          file: first.name,
          reason: first.reason,
        }),
  );
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
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface-muted px-4 py-2 text-meta">
      <span className="font-medium">{t("{{n}} selected", { n: selected.length })}</span>
      {selected.length < total ? (
        <Button type="button" variant="ghost" size="sm" onClick={onSelectAll}>
          {t("Select all {{total}}", { total })}
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        {t("Clear")}
      </Button>

      <span className="flex-1" />

      {bundles.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="sm">
              <Folder className="mr-2 h-4 w-4" />
              {t("Move to")}
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
      <Button type="button" variant="secondary" size="sm" onClick={onDelete}>
        <Trash2 className="mr-2 h-4 w-4" />
        {t("Delete")}
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
  page,
  openName,
  bundles,
  agent,
  selection,
  onSelect,
  canWrite,
  dropping,
  readers,
  onAttach,
}: {
  /** The Knowledge page's column (A6): folders, sources, the drop hint. */
  page: boolean;
  /** The open folder's name, for the hint at the foot. */
  openName: string | null;
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
  /** Opens the attach dialog for a folder; null where there is nothing to attach to. */
  onAttach: ((b: ReturnType<typeof useAgentsStore>["bundles"][number]) => void) | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const store = useAgentsStore();
  const [railQuery, setRailQuery] = useState("");

  // A search rather than a "hide empty folders" switch, which was the other
  // way to make a long list shorter: the empty folder is the one somebody is
  // looking for, because it is the one waiting to be filled.
  const needle = railQuery.trim().toLocaleLowerCase(locale);
  const matching = needle
    ? bundles.filter((b) => b.name.toLocaleLowerCase(locale).includes(needle))
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
      onAttach={onAttach}
    />
  );

  return (
    <aside
      aria-label={t("Folders")}
      className={cn(
        page
          ? "w-60 shrink-0 flex-col border-r border-hairline bg-background"
          : "flex w-full shrink-0 flex-col border-b border-hairline bg-surface-muted lg:w-60 lg:border-b-0 lg:border-r",
        // On a phone the workspace page navigates like a file manager does —
        // folders in the pane, the path in the bar — and the column would be
        // the same list twice. An agent's tab keeps it: the switches are here.
        !agent && "hidden lg:flex",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto",
          page ? "px-3 py-4" : "px-2 py-2",
        )}
      >
        {page && <SidebarHeading>{t("Folders")}</SidebarHeading>}
        {agent ? (
          <PlaceRow
            icon={<HardDrive className="h-4 w-4" />}
            selected={selection?.kind === "all"}
            onClick={() => onSelect({ kind: "all" })}
            count={agent.documents.length}
          >
            {t("Everything {{agent}} reads", { agent: agent.name })}
          </PlaceRow>
        ) : (
          <PlaceRow
            icon={<HardDrive className="h-4 w-4" />}
            selected={selection?.kind === "root"}
            onClick={() => onSelect({ kind: "root" })}
            count={total}
          >
            {page ? t("All files") : t("Knowledge")}
          </PlaceRow>
        )}

        {bundles.length > RAIL_SEARCH_AFTER ? (
          <div className="relative px-2 pb-1 pt-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={railQuery}
              onChange={(e) => setRailQuery(e.target.value)}
              placeholder={t("Find a folder")}
              aria-label={t("Find a folder by name")}
              className="h-8 bg-background pl-8 text-meta"
            />
          </div>
        ) : null}

        {bundles.length === 0 ? (
          <p className="px-3 py-4 text-meta text-muted-foreground">
            {canWrite ? t("No folders yet. Make the first one below.") : t("No folders yet.")}
          </p>
        ) : matching.length === 0 ? (
          <p className="px-3 py-4 text-meta text-muted-foreground">
            {t('No folder is called "{{query}}".', { query: railQuery.trim() })}
          </p>
        ) : (
          <>
            {!page && <SidebarHeading>{agent ? t("Attached") : t("Folders")}</SidebarHeading>}
            {attached.length === 0 ? (
              <p className="px-3 py-2 text-meta text-muted-foreground">
                {t("Nothing attached, so this agent reads nothing but its persona.")}
              </p>
            ) : (
              attached.map(row)
            )}
            {detached.length > 0 ? (
              <>
                <SidebarHeading>{t("Not attached")}</SidebarHeading>
                {detached.map(row)}
              </>
            ) : null}
          </>
        )}
        {page && <SourceRows onNavigate={() => {}} />}
        {page && openName && canWrite && (
          <p className="mt-auto px-2 pt-6 text-xs leading-[1.5] text-micro-foreground">
            {t("Drop files anywhere in this window to add them to {{folder}}.", {
              folder: openName,
            })}
          </p>
        )}
      </div>

      {canWrite && !page ? (
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
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
        selected
          ? "bg-surface font-medium text-foreground"
          : "text-nav-foreground hover:bg-surface",
      )}
    >
      <span className={cn("shrink-0", selected ? "text-foreground" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-xs text-micro-foreground tabular-nums">{count}</span>
    </button>
  );
}

function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-5 pb-1.5 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase first:pt-0">
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
  onAttach,
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
  onAttach: ((b: ReturnType<typeof useAgentsStore>["bundles"][number]) => void) | null;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(bundle.name);
  const { setNodeRef, isOver } = useDroppable({ id: bundle.id, disabled: !canWrite });

  const toggleShared = () => {
    const sharing = bundle.shared === false;
    const ask = sharing
      ? t(
          'Share "{{folder}}" with the workspace? Everyone in it will be able to read its files, and the agents it is attached to will use it in their conversations too.',
          { folder: bundle.name },
        )
      : t(
          'Stop sharing "{{folder}}"? Only you will see its files, and agents will use it only in your own private conversations.',
          { folder: bundle.name },
        );
    if (!confirm(ask)) return;
    store
      .updateBundle(bundle.id, { shared: sharing })
      .then(() =>
        toast.success(
          sharing
            ? t("Shared {{folder}}", { folder: bundle.name })
            : t("{{folder}} is only yours now", { folder: bundle.name }),
        ),
      )
      .catch((err) => toast.error(err?.message ?? t("Could not change who sees it")));
  };

  const commit = () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === bundle.name) return;
    store
      .updateBundle(bundle.id, { name })
      .then(() => toast.success(t("Renamed to {{name}}", { name })))
      .catch((err) =>
        toast.error(
          err?.message
            ? t("Rename failed: {{reason}}", { reason: err.message })
            : t("Rename failed"),
        ),
      );
  };

  if (renaming) {
    return (
      <div className="px-2 py-1">
        <Input
          autoFocus
          value={draft}
          aria-label={t("Rename {{folder}}", { folder: bundle.name })}
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
        "group flex items-center gap-1 rounded-md pr-1 transition-colors",
        selected ? "bg-surface text-foreground" : "text-nav-foreground hover:bg-surface",
        // Dashed while anything is in the air, so every place a file can land
        // says so; solid under the one it would land on now.
        dropping && "outline-dashed outline-1 outline-border",
        isOver && "bg-surface outline outline-1 outline-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={t("Open {{folder}}", { folder: bundle.name })}
        aria-current={selected ? "location" : undefined}
        title={
          [
            bundle.shared === false ? t("Only you can see this folder.") : null,
            unread ? t("No agent reads this folder.") : null,
            folderDescription(bundle.description),
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        className="flex h-[30px] min-w-0 flex-1 items-center gap-2 pl-2 text-left text-sm"
      >
        {selected ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-foreground" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>
          {bundle.name}
        </span>
        {/* Said, not only drawn: the lock and the dot each carry their words
            for a screen reader, and the title above repeats them for a hover. */}
        {bundle.shared === false ? (
          <>
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">{t("Only you")}</span>
          </>
        ) : null}
        {unread ? (
          <>
            {/* The one state worth a mark in a list of folders: a folder no
                agent has attached is one nothing can read out of. */}
            <StatusDot state="idle" />
            <span className="sr-only">{t("no agent reads it")}</span>
          </>
        ) : null}
        <span className="shrink-0 pl-1 text-xs text-micro-foreground tabular-nums">
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
          aria-label={t("Attach {{folder}} to {{agent}}", {
            folder: bundle.name,
            agent: agent.name,
          })}
        />
      ) : null}

      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={t("Actions for {{folder}}", { folder: bundle.name })}
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(bundle.name);
                setRenaming(true);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("Rename")}
            </DropdownMenuItem>
            {onAttach ? (
              <DropdownMenuItem onSelect={() => onAttach(bundle)}>
                <Bot className="mr-2 h-4 w-4" />
                {t("Attach to agents…")}
              </DropdownMenuItem>
            ) : null}
            {/* Only its maker shares it or takes it back (0106). */}
            {bundle.mine ? (
              <DropdownMenuItem onSelect={() => toggleShared()}>
                {bundle.shared === false ? (
                  <Users className="mr-2 h-4 w-4" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                {bundle.shared === false ? t("Share with the workspace") : t("Stop sharing")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                if (
                  confirm(
                    t(
                      'Delete "{{folder}}"? Its files go with it and it detaches from every agent. It waits 30 days in Settings → Recently deleted, and restoring it brings the files back too.',
                      { folder: bundle.name },
                    ),
                  )
                ) {
                  store.removeBundle(bundle.id);
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete folder")}
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
  const { t } = useTranslation();
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
          shared
            ? t("Created {{folder}}, shared with the workspace", { folder: bundle.name })
            : t("Created {{folder}}", { folder: bundle.name }),
        );
      })
      .catch((err) =>
        toast.error(
          err?.message
            ? t("Create failed: {{reason}}", { reason: err.message })
            : t("Create failed"),
        ),
      )
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
        {t("New folder")}
      </button>
    );
  }

  return (
    <div className="p-1">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          placeholder={t("Folder name")}
          aria-label={t("Folder name")}
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
          variant="secondary"
          size="sm"
          onClick={create}
          disabled={creating || !name.trim()}
        >
          {t("Add")}
        </Button>
      </div>
      {/* Off by default (0106): a folder is its maker's until they share it. */}
      <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={shared}
          onCheckedChange={(on) => setShared(on === true)}
          aria-label={t("Share the new folder with the workspace")}
        />
        {t("Share with the workspace")}
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
  const { t } = useTranslation();
  const root = agent ? t("Everything {{agent}} reads", { agent: agent.name }) : t("Knowledge");
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-2 py-2">
      <button
        type="button"
        onClick={onHome}
        disabled={home}
        aria-label={t("Back")}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      <nav
        aria-label={t("Where you are")}
        className="flex min-w-0 flex-1 items-center gap-1 text-sm"
      >
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
                <Lock
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                  aria-label={t("Only you")}
                />
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
              ? t("Search in {{folder}}", { folder: openBundle.name })
              : home && !agent
                ? t("Search folders")
                : t("Search files")
          }
          aria-label={t("Search files by name")}
          className="h-8 bg-background pl-8 text-meta"
        />
      </div>

      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-hairline p-0.5">
        <ViewButton active={view === "list"} onClick={() => onView("list")} label={t("List view")}>
          <List className="h-4 w-4" />
        </ViewButton>
        <ViewButton active={view === "grid"} onClick={() => onView("grid")} label={t("Grid view")}>
          <LayoutGrid className="h-4 w-4" />
        </ViewButton>
      </div>

      {canWrite && openBundle ? (
        <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm font-medium transition-colors hover:bg-surface-hover">
          <Upload className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{t("Upload")}</span>
          <input
            type="file"
            multiple
            className="hidden"
            accept={ACCEPT}
            aria-label={t("Upload files into {{folder}}", { folder: openBundle.name })}
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
  onAttach,
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
  /** Opens the attach dialog for the open folder; null where nothing can be attached. */
  onAttach: (() => void) | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  // A filter with nothing to find is not offered — except the one that is on,
  // which has to stay on the screen or there would be no way back to All.
  const chips = (
    [
      { key: "unindexed", label: t("Needs indexing"), count: tallies.unindexed },
      { key: "stale", label: t("Older than 90 days"), count: tallies.stale },
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
          {readers.length > 0 ? (
            t("Read by {{agents}}.", { agents: listOf(readers, t, locale) })
          ) : onAttach ? (
            <>
              {t("No agent reads this folder yet.")}{" "}
              <button
                type="button"
                onClick={onAttach}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                {t("Attach it to an agent")}
              </button>
            </>
          ) : (
            t("No agent reads this folder yet — attach it from an agent's Knowledge tab.")
          )}
        </span>
      ) : null}
      {viewerNote ? (
        <span>
          {t("You can read everything here. Uploading, moving and deleting are a member's job.")}
        </span>
      ) : null}
      {chips.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={filter === "all"} onClick={() => onFilter("all")}>
            {t("All")}
          </FilterChip>
          {chips.map((c) => (
            <FilterChip
              key={c.key}
              active={filter === c.key}
              onClick={() => onFilter(c.key)}
              // Spelled out, because the number sits against the label with no
              // space between them and "Needs indexing3" is what is read out.
              label={t("{{filter}}, {{count}} file", {
                filter: c.label,
                count: c.count,
                defaultValue_other: "{{filter}}, {{count}} files",
              })}
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
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("Open {{folder}}", { folder: bundle.name })}
      title={folderDescription(bundle.description) ?? undefined}
      className="flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-center transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      <span className="relative">
        <Folder className="h-12 w-12 fill-muted text-muted-foreground" strokeWidth={1.25} />
        {bundle.shared === false ? (
          <Lock
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-surface p-0.5 text-foreground"
            aria-label={t("Only you")}
          />
        ) : null}
      </span>
      <span className="line-clamp-2 w-full text-meta font-medium leading-tight [overflow-wrap:anywhere]">
        {bundle.name}
      </span>
      <span className="text-xs text-muted-foreground">
        {t("{{count}} file", {
          count: bundle.documentCount,
          defaultValue_other: "{{count}} files",
        })}
        {readers && readers.length === 0 ? ` · ${t("no agent")}` : ""}
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
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div>
      <div className="hidden h-9 items-center gap-3 border-b border-border px-6 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase md:flex">
        <span className="w-4 shrink-0" />
        <span className="flex-1">{t("Name")}</span>
        <span className="w-20 shrink-0">{t("Files")}</span>
        {readers ? <span className="hidden w-40 shrink-0 lg:block">{t("Read by")}</span> : null}
        <span className="w-28 shrink-0">{t("Created")}</span>
      </div>
      <div className="divide-y divide-hairline">
        {bundles.map((b) => {
          const who = readers?.[b.id];
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onOpen(b.id)}
              aria-label={t("Open {{folder}}", { folder: b.name })}
              className="flex min-h-11 w-full items-center gap-3 px-6 py-1.5 text-left text-sm transition-colors hover:bg-surface-muted"
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-medium">{b.name}</span>
                {b.shared === false ? (
                  <>
                    <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="sr-only">{t("Only you")}</span>
                  </>
                ) : null}
                {folderDescription(b.description) ? (
                  <span className="hidden truncate text-xs text-muted-foreground md:inline">
                    · {folderDescription(b.description)}
                  </span>
                ) : null}
              </span>
              <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">
                {t("{{count}} file", {
                  count: b.documentCount,
                  defaultValue_other: "{{count}} files",
                })}
              </span>
              {readers ? (
                <span
                  className={cn(
                    "hidden w-40 shrink-0 truncate text-xs text-muted-foreground lg:block",
                    who && who.length === 0 && "text-foreground",
                  )}
                >
                  {who && who.length > 0 ? listOf(who, t, locale) : t("No agent")}
                </span>
              ) : null}
              <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block">
                {b.createdAt ? documentAge(b.createdAt, undefined, t, locale).label : ""}
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
  // i18n-ignore: a file extension, matched against ASCII ones.
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

/** "Ada", "Ada and Ops bot", "Ada, Ops bot and 2 more" — joined the reader's way. */
function listOf(names: string[], t: Translate, locale: string): string {
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  if (names.length <= 2) return list.format(names);
  return list.format([
    ...names.slice(0, 2),
    t("{{count}} more", { count: names.length - 2, defaultValue_other: "{{count}} more" }),
  ]);
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
        "grid size-[30px] place-items-center transition-colors",
        active ? "bg-surface text-foreground" : "text-muted-foreground hover:text-foreground",
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
  readers,
  onOpenBundle,
  onSelectAll,
  onClearSelection,
  ...actions
}: RowActions & {
  documents: ExplorerDocument[];
  showBundle: boolean;
  sort: Sort;
  onSort: (k: SortKey) => void;
  /** Which agents read each folder, by name: the Used by column. */
  readers: Record<string, string[]>;
  onOpenBundle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}) {
  const { t } = useTranslation();
  const allTicked = documents.length > 0 && documents.every((d) => actions.selected.has(d.id));

  return (
    <div>
      {/* The header is a row of buttons rather than a <thead>, because the rows
          below it are not a table on a phone: the columns fold into the line
          under the name and the header folds away with them. */}
      <div className="hidden h-9 items-center gap-3 border-b border-border px-6 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase md:flex">
        {actions.canWrite ? (
          <Checkbox
            checked={allTicked}
            onClick={() => (allTicked ? onClearSelection() : onSelectAll())}
            aria-label={allTicked ? t("Clear the selection") : t("Select every file here")}
          />
        ) : null}
        <SortHeader className="flex-1 pl-10" active={sort} sortKey="name" onSort={onSort}>
          {t("Name")}
        </SortHeader>
        <span className="hidden w-20 shrink-0 lg:block">{t("Kind")}</span>
        <SortHeader
          className="w-16 shrink-0 justify-end"
          active={sort}
          sortKey="size"
          onSort={onSort}
        >
          {t("Size")}
        </SortHeader>
        <span className="hidden w-28 shrink-0 lg:block">{t("Added by")}</span>
        <SortHeader
          className="hidden w-24 shrink-0 lg:flex"
          active={sort}
          sortKey="createdAt"
          onSort={onSort}
        >
          {t("Modified")}
        </SortHeader>
        <span className="hidden w-40 shrink-0 xl:block">{t("Used by")}</span>
        <span className="w-8 shrink-0" />
      </div>

      <div className="divide-y divide-hairline">
        {documents.map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            showBundle={showBundle}
            readers={doc.bundleId ? (readers[doc.bundleId] ?? []) : []}
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
  const { t } = useTranslation();
  const locale = useLocale();
  const on = active.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={t("Sort by {{column}}", {
        column: String(children).toLocaleLowerCase(locale),
      })}
      className={cn(
        "flex items-center gap-1 text-left tracking-[0.06em] uppercase transition-colors hover:text-foreground",
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
  readers,
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
  readers: string[];
  onOpenBundle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const aRoutine = t("a routine");
  const age = documentAge(doc.createdAt, undefined, t, locale);
  const bundle = doc.bundleId ? bundles.find((b) => b.id === doc.bundleId) : undefined;
  const ticked = selected.has(doc.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: doc.id,
    disabled: !canWrite,
  });
  const kind = extensionLabel(doc.name);

  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-3 px-6 py-1.5 text-sm transition-colors hover:bg-surface-muted",
        ticked && "bg-surface-muted",
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
          aria-label={t("Select {{name}}", { name: doc.name })}
        />
      ) : null}

      {/* The kind, as A6 draws it: a 28px grey tile with its letters. It is
          also the handle a file is dragged onto a folder by. */}
      {canWrite ? (
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t("Drag {{name}}", { name: doc.name })}
          title={t("Drag onto a folder on the left to move it there")}
          className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md bg-surface text-[9px] font-semibold tracking-[0.04em] text-muted-foreground active:cursor-grabbing"
        >
          {kind.slice(0, 3)}
        </button>
      ) : (
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-[9px] font-semibold tracking-[0.04em] text-muted-foreground">
          {kind.slice(0, 3)}
        </span>
      )}

      <button
        type="button"
        onClick={() => onOpen(doc)}
        className="min-w-0 flex-1 text-left"
        aria-label={t("Open {{name}}", { name: doc.name })}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span data-part="name" className="truncate font-medium [overflow-wrap:anywhere]">
            {doc.name}
          </span>
          {/* Only when it is not plain sailing: still indexing, cut short or
              failed. A file that is ready says nothing. */}
          {doc.indexed && doc.indexStatus !== "partial" ? null : <IndexChip doc={doc} />}
        </span>
        {/* Where it came from, on the line under the name: a file a routine
            wrote is the sort of thing a person wants to know before they
            trust it — and a routine id with no name is a colleague's private
            routine, which is a thing the reader cannot be shown. */}
        {doc.routineId ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {t("Written by {{routine}}", { routine: doc.routineName ?? aRoutine })}
          </span>
        ) : null}
        {/* The columns that fold away on a narrow screen say themselves here
            instead, so nothing is reachable only at desktop width. */}
        <span className="mt-0.5 block truncate text-xs text-muted-foreground md:hidden">
          {formatFileSize(doc.size, locale)} · {age.label}
        </span>
      </button>

      {showBundle && bundle ? (
        <button
          type="button"
          onClick={() => onOpenBundle(bundle.id)}
          className="hidden shrink-0 sm:block"
          aria-label={t("Open {{folder}}", { folder: bundle.name })}
        >
          <Chip tone="code">{bundle.name}</Chip>
        </button>
      ) : null}

      <span className="hidden w-20 shrink-0 text-muted-foreground lg:block">
        {kindWord(kind, t)}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-muted-foreground tabular-nums md:block">
        {formatFileSize(doc.size, locale)}
      </span>
      <span className="hidden w-28 shrink-0 items-center gap-2 truncate lg:flex">
        {doc.connectionId ? (
          <SourceName connectionId={doc.connectionId} />
        ) : doc.routineId ? (
          <span className="truncate text-muted-foreground">{t("A routine")}</span>
        ) : doc.createdBy ? (
          <>
            <Avatar name={doc.createdBy.name} size={20} />
            <span className="truncate">{shortName(doc.createdBy.name, t, locale)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span className="hidden w-24 shrink-0 text-muted-foreground lg:block">
        {agoShort(doc.createdAt, undefined, t, locale)}
        {age.stale ? <span className="sr-only"> ({t("older than 90 days")})</span> : null}
      </span>
      <span className="hidden w-40 shrink-0 gap-1 overflow-hidden xl:flex">
        {readers.length > 0 ? (
          readers.slice(0, 2).map((name) => <Chip key={name}>{name}</Chip>)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {readers.length > 2 ? <Chip>+{readers.length - 2}</Chip> : null}
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

/** Format names, the same in every language. */
const KIND_NAME: Record<string, string> = {
  DOC: "Word",
  DOCX: "Word",
  XLS: "Excel",
  XLSX: "Excel",
  CSV: "CSV",
  MD: "Markdown",
};

/** Kinds said in words, which are the reader's. */
const KIND_WORD: Record<string, string> = {
  TXT: msg("Text"),
  PPT: msg("Slides"),
  PPTX: msg("Slides"),
  HTML: msg("Web page"),
  WEB: msg("Web page"),
};

/** "PDF" → "PDF", "DOCX" → "Word": the Kind column (A6). */
function kindWord(ext: string, t: Translate): string {
  const word = KIND_WORD[ext];
  return word ? lookup(t, word) : (KIND_NAME[ext] ?? ext);
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
  const { t } = useTranslation();
  const locale = useLocale();
  const aRoutine = t("a routine");
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
              aria-label={t("Select {{name}}", { name: doc.name })}
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
          aria-label={t("Drag {{name}}", { name: doc.name })}
          title={t("Drag onto a folder on the left to move it there")}
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
        aria-label={t("Open {{name}}", { name: doc.name })}
        className="line-clamp-2 text-center text-meta font-medium leading-tight [overflow-wrap:anywhere]"
      >
        {doc.name}
      </button>
      {doc.routineId ? (
        <span className="truncate text-center text-xs text-muted-foreground">
          {t("Written by {{routine}}", { routine: doc.routineName ?? aRoutine })}
        </span>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{formatFileSize(doc.size, locale)}</span>
        <IndexChip doc={doc} />
      </div>
    </div>
  );
}

function extensionLabel(name: string): string {
  if (/^https?:\/\//i.test(name)) return "WEB";
  // i18n-ignore: a file extension, matched against ASCII ones.
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  // i18n-ignore: drawn as a code, like the extension it stands in for.
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
  const { t } = useTranslation();
  const elsewhere = bundles.filter((b) => b.id !== doc.bundleId);
  const queryClient = useQueryClient();

  const resync = async () => {
    try {
      await api.documents.resync(doc.id);
      toast.success(t("{{name}} will be synced in the next minute or two", { name: doc.name }));
    } catch (err) {
      toast.error((err as Error)?.message ?? t("Could not sync it"));
    }
  };

  const [renaming, setRenaming] = useState(false);
  const rename = async (next: string): Promise<boolean> => {
    if (next === doc.name) return true;
    try {
      await api.documents.rename(doc.id, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bundle-documents"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]);
      toast.success(t("Renamed to {{name}}", { name: next }));
      return true;
    } catch (err) {
      toast.error((err as Error)?.message ?? t("Rename failed"));
      return false;
    }
  };

  return (
    <>
      <TextPromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("Rename {{name}}", { name: doc.name })}
        label={t("Name")}
        initialValue={doc.name}
        submitLabel={t("Rename")}
        busyLabel={t("Renaming…")}
        onSubmit={rename}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          aria-label={t("Actions for {{name}}", { name: doc.name })}
          disabled={busy}
        >
          {busy ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => onOpen(doc)}>
            <FileText className="mr-2 h-4 w-4" />
            {t("Open")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void api.documents.download(doc.id, doc.name)}>
            <Download className="mr-2 h-4 w-4" />
            {t("Download")}
          </DropdownMenuItem>
          {doc.externalUrl ? (
            <DropdownMenuItem asChild>
              <a href={doc.externalUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="mr-2 h-4 w-4" />
                {t("Open at the source")}
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
                    {t("Move to")}
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
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("Rename")}
                </DropdownMenuItem>
              ) : null}
              {doc.connectionId ? (
                <DropdownMenuItem onSelect={() => void resync()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("Sync now")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onReindex(doc)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("Reindex")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onRemove(doc)}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t("Delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * A web page, as a document. The server fetches it — a browser could not read
 * most sites from here anyway — keeps the HTML and indexes its text. A
 * snapshot: adding the page again later is how it is refreshed.
 */
function AddWebPage({ bundleId }: { bundleId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const add = async (typed: string): Promise<boolean> => {
    // People type "example.com/page"; the API wants a whole URL.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
    try {
      const doc = await api.bundles.addUrl(bundleId, url);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bundle-documents"] }),
        queryClient.invalidateQueries({ queryKey: ["bundles"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
      ]);
      toast.success(t("Added {{file}} — indexing it now", { file: doc.name }));
      return true;
    } catch (err) {
      toast.error((err as Error)?.message ?? t("Could not add that page"));
      return false;
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t("Add a web page")}
      </button>
      <TextPromptDialog
        open={open}
        onOpenChange={setOpen}
        title={t("Add a web page")}
        label={t("Address")}
        type="url"
        placeholder={"https://example.com/page"}
        submitLabel={t("Add page")}
        busyLabel={t("Fetching the page…")}
        onSubmit={add}
      />
    </>
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
  const { t } = useTranslation();
  return (
    <div className="border-t border-hairline px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Upload className="h-3.5 w-3.5" />
          {bundle ? (
            <>
              <span>{t("Drop files into {{folder}}", { folder: bundle.name })}</span>
              <span>{t("or")}</span>
              <label className="cursor-pointer underline underline-offset-2 hover:text-foreground">
                {t("choose files")}
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
            <span>{t("Pick a folder to upload into")}</span>
          )}
        </span>
        {bundle ? (
          <>
            {/* A folder picker of its own: the same input cannot pick both
                files and folders, and the drop target already takes both. */}
            <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
              <FolderOpen className="h-3.5 w-3.5" />
              {t("Upload a folder")}
              <input
                type="file"
                multiple
                className="hidden"
                aria-label={t("Upload a folder")}
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
            <span className="hidden xl:inline">{acceptedSummary(t)}</span>
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
                    ? t("Waiting…")
                    : u.phase === "reading"
                      ? t("Reading the PDF…")
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
  const { t } = useTranslation();
  const passages = t("{{count}} passage", {
    count: doc.chunkCount,
    defaultValue_other: "{{count}} passages",
  });
  switch (doc.indexStatus) {
    case "queued":
      return (
        <span title={t("Waiting to be read and indexed.")}>
          <Chip>{t("Queued")}</Chip>
        </span>
      );
    case "indexing": {
      const p = doc.indexProgress;
      const pct = p && p.total > 0 ? Math.min(99, Math.round((p.done / p.total) * 100)) : null;
      return (
        <span
          title={t("Being indexed. Until it finishes, any passages it had before still answer.")}
        >
          <Chip>{pct === null ? t("Indexing…") : t("Indexing {{pct}}%", { pct })}</Chip>
        </span>
      );
    }
    case "failed":
      return (
        <span title={doc.indexError ?? t("Indexing failed. Reindex to try again.")}>
          <Chip className="text-destructive">{t("Failed")}</Chip>
        </span>
      );
    case "partial":
      return (
        <span
          title={t(
            "{{passages}}. The document is longer than the indexing limit, so only its first part is searchable.",
            { passages },
          )}
        >
          <Chip>{t("Partly indexed")}</Chip>
        </span>
      );
    default:
      return doc.indexed ? (
        <span title={passages}>
          <Chip>{t("Indexed")}</Chip>
        </span>
      ) : (
        <span title={t("No embeddings yet — no passage in it can be matched in chat.")}>
          <Chip>{t("Not indexed")}</Chip>
        </span>
      );
  }
}

/* --------------------------------------------------------- the page chrome */

/**
 * The bar over the Knowledge page (A6): where you are as a path, and the
 * window's controls — search, list or grid, New folder, Upload. The path's
 * first step is the way back to the root.
 */
function KnowledgeTopBar({
  openBundle,
  home,
  canWrite,
  view,
  onView,
  query,
  onQuery,
  onHome,
  onFiles,
  onCreated,
}: {
  openBundle: ReturnType<typeof useAgentsStore>["bundles"][number] | null;
  home: boolean;
  canWrite: boolean;
  view: "list" | "grid";
  onView: (v: "list" | "grid") => void;
  query: string;
  onQuery: (q: string) => void;
  onHome: () => void;
  onFiles: (files: FileList | File[] | null) => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <TopBar
        title={
          openBundle ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={onHome}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {t("Knowledge")}
              </button>
              <span aria-hidden className="font-normal text-dot-done">
                /
              </span>
              <span className="truncate">{openBundle.name}</span>
              {openBundle.shared === false ? (
                <Lock
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label={t("Only you")}
                />
              ) : null}
            </span>
          ) : (
            t("Knowledge")
          )
        }
        actions={
          <>
            <div className="relative w-60">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder={
                  openBundle ? t("Search files") : home ? t("Search folders") : t("Search files")
                }
                aria-label={t("Search files by name")}
                className="pl-8"
              />
            </div>
            <div className="flex shrink-0 overflow-hidden rounded-md border border-input">
              <ViewButton
                active={view === "list"}
                onClick={() => onView("list")}
                label={t("List view")}
              >
                <List className="size-4" />
              </ViewButton>
              <ViewButton
                active={view === "grid"}
                onClick={() => onView("grid")}
                label={t("Grid view")}
              >
                <LayoutGrid className="size-4" />
              </ViewButton>
            </div>
            {canWrite && (
              <Button variant="secondary" onClick={() => setCreating(true)}>
                {t("New folder")}
              </Button>
            )}
            {canWrite && openBundle && (
              <Button onClick={() => fileRef.current?.click()}>
                <Upload /> {t("Upload")}
              </Button>
            )}
          </>
        }
        phoneActions={
          canWrite && openBundle ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Upload files into {{folder}}", { folder: openBundle.name })}
              onClick={() => fileRef.current?.click()}
            >
              <Upload />
            </Button>
          ) : undefined
        }
      />
      {canWrite && openBundle && (
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          accept={ACCEPT}
          aria-label={t("Upload files into {{folder}}", { folder: openBundle.name })}
          onChange={(e) => {
            // Copied before the reset — see the strip at the foot of the pane.
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            onFiles(files);
          }}
        />
      )}
      <NewFolderDialog open={creating} onOpenChange={setCreating} onCreated={onCreated} />
    </>
  );
}

/**
 * "New folder" (A6): a name, and whether the workspace sees it — off by
 * default (0106), a folder is its maker's until they share it.
 */
function NewFolderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { createBundle } = useAgentsStore();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    createBundle(trimmed, undefined, shared)
      .then((bundle) => {
        setName("");
        setShared(false);
        onOpenChange(false);
        onCreated(bundle.id);
        toast.success(
          shared
            ? t("Created {{folder}}, shared with the workspace", { folder: bundle.name })
            : t("Created {{folder}}", { folder: bundle.name }),
        );
      })
      .catch((err) =>
        toast.error(
          err?.message
            ? t("Create failed: {{reason}}", { reason: err.message })
            : t("Create failed"),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("New folder")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={create} className="flex flex-col gap-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="new-folder-name">{t("Name")}</Label>
            <Input
              id="new-folder-name"
              autoFocus
              value={name}
              disabled={busy}
              placeholder={t("Contracts")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("Share with the workspace")}
              <span className="block text-meta text-muted-foreground">
                {t("Off, only you see it until you share it.")}
              </span>
            </span>
            <Switch
              checked={shared}
              onCheckedChange={setShared}
              aria-label={t("Share the new folder with the workspace")}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? t("Creating…") : t("Create folder")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The column's second group (A6): the apps the workspace keeps files in sync
 * from, each with when it last did, and the way to add one.
 */
function SourceRows({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const { data } = useConnections();
  const connections = data?.connections ?? [];
  return (
    <>
      <SidebarHeading>{t("Sources")}</SidebarHeading>
      {connections.map((c) => {
        const label = data?.providers.find((p) => p.id === c.provider)?.label ?? c.provider;
        return (
          <Link
            key={c.id}
            to="/settings/integrations"
            onClick={onNavigate}
            className="flex h-[30px] items-center gap-2 rounded-md px-2 text-sm text-nav-foreground hover:bg-surface"
          >
            <Tile label={label} size={16} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-micro-foreground">
              <StatusDot state={c.status === "paused" ? "failed" : "done"} />
              {c.lastSyncAt ? sinceShort(c.lastSyncAt, t) : t("Not yet")}
            </span>
          </Link>
        );
      })}
      <Link
        to="/settings/integrations"
        onClick={onNavigate}
        className="flex h-[30px] items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground"
      >
        <Plus className="size-4" />
        {t("Add a source")}
      </Link>
    </>
  );
}

/** "12 min", "1 h", "3 d": how long ago a source last synced. */
function sinceShort(at: number, t: Translate): string {
  const min = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (min < 60) return t("{{minutes}} min", { minutes: min });
  const h = Math.round(min / 60);
  if (h < 24) return t("{{hours}} h", { hours: h });
  return t("{{days}} d", { days: Math.round(h / 24) });
}

/** "Drive synced 12 min ago": the open folder's source, when it has one. */
function FolderSync({ bundleId }: { bundleId: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data } = useConnections();
  const c = data?.connections.find((x) => x.bundleId === bundleId);
  if (!c) return null;
  const label = data?.providers.find((p) => p.id === c.provider)?.label ?? c.provider;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot state={c.status === "paused" ? "failed" : "done"} />
      {c.status === "paused"
        ? t("{{source}} paused", { source: label })
        : c.lastSyncAt
          ? t("{{source}} synced {{when}}", {
              source: label,
              when: lastActivityLabel(c.lastSyncAt, undefined, t, locale).toLocaleLowerCase(locale),
            })
          : t("{{source}} has not synced yet", { source: label })}
    </span>
  );
}

/** "GD Drive": a synced file's source, as the Added by column says it (A6). */
function SourceName({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const { data } = useConnections();
  const c = data?.connections.find((x) => x.id === connectionId);
  const label = c
    ? (data?.providers.find((p) => p.id === c.provider)?.label ?? c.provider)
    : t("A source");
  return (
    <>
      <Tile label={label} size={20} />
      <span className="truncate">{label.replace(/^Google /, "")}</span>
    </>
  );
}
