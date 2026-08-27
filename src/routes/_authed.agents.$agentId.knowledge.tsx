import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAgentsStore } from "@/lib/agents-store";
import { api } from "@/lib/api-client";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { Chip, EmptyState } from "@/components/section-card";
import { DocsLink } from "@/components/docs-link";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { validateUpload } from "@/lib/uploads";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/agents/$agentId/knowledge")({
  component: KnowledgeTab,
});

type Uploading = { id: string; name: string; size: number; progress: number };

function KnowledgeTab() {
  const { agentId } = Route.useParams();
  const {
    agents,
    bundles,
    uploadToBundle,
    removeDocument,
    createBundle,
    attachBundle,
    detachBundle,
    removeBundle,
    reindexDocument,
    canWrite,
  } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId)!;

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [newBundleName, setNewBundleName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState<Set<string>>(new Set());

  const selectedBundle = bundles.find((b) => b.id === selectedBundleId) ?? null;

  const toggleBundle = (bundleId: string, on: boolean) => {
    if (on) attachBundle(agent.id, bundleId);
    else detachBundle(agent.id, bundleId);
  };

  const deleteBundle = (bundleId: string, name: string) => {
    if (
      !confirm(
        `Delete "${name}"? This permanently removes its documents and detaches it from every agent. This cannot be undone.`,
      )
    ) {
      return;
    }
    if (selectedBundleId === bundleId) setSelectedBundleId(null);
    removeBundle(bundleId);
  };

  const create = () => {
    const name = newBundleName.trim();
    if (!name) {
      toast.error("Give the bundle a name.");
      return;
    }
    setCreating(true);
    createBundle(name)
      .then((bundle) => {
        setNewBundleName("");
        setSelectedBundleId(bundle.id);
        toast.success(`Created ${bundle.name}`);
      })
      .catch((err) => toast.error(err?.message ? `Create failed: ${err.message}` : "Create failed"))
      .finally(() => setCreating(false));
  };

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!selectedBundleId) {
      toast.error("Pick a bundle to upload into first.");
      return;
    }
    for (const file of Array.from(files)) {
      const check = validateUpload(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      const id = `u_${crypto.randomUUID()}`;
      setUploading((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0 }]);
      uploadToBundle(selectedBundleId, file, (pct) =>
        setUploading((prev) => prev.map((u) => (u.id === id ? { ...u, progress: pct } : u))),
      )
        .then((doc) => {
          setUploading((prev) => prev.filter((u) => u.id !== id));
          if (doc.indexed) {
            toast.success(`Added ${file.name}`);
          } else {
            // Same wording as the chat composer's warning in use-chat-uploads:
            // stored and listed, but no passage in it can be matched.
            toast.warning(
              `${file.name} went in but could not be indexed, so answers won't be grounded in it.`,
            );
          }
        })
        .catch((err) => {
          setUploading((prev) => prev.filter((u) => u.id !== id));
          toast.error(err?.message ? `Upload failed: ${err.message}` : "Upload failed");
        });
    }
  };

  const remove = (id: string) => {
    removeDocument(agent.id, id)
      .then(() => toast.success("Document removed"))
      .catch((err) =>
        toast.error(err?.message ? `Remove failed: ${err.message}` : "Remove failed"),
      );
  };

  const reindex = (id: string, name: string) => {
    setReindexing((p) => new Set(p).add(id));
    reindexDocument(id)
      .then((doc) =>
        toast.success(
          `Reindexed ${name} — ${doc.chunkCount} ${doc.chunkCount === 1 ? "chunk" : "chunks"}`,
        ),
      )
      .catch((err) =>
        toast.error(err?.message ? `Reindex failed: ${err.message}` : "Reindex failed"),
      )
      .finally(() =>
        setReindexing((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        }),
      );
  };

  return (
    <PageContainer width="form">
      <PageHeader
        badge="Knowledge"
        title="Upload once."
        turn="Every agent can read it."
        subtitle="A bundle is a group of documents. Attach one here, and the same bundle can back every other agent too."
      >
        <DocsLink page="knowledge">How retrieval picks a passage</DocsLink>
      </PageHeader>

      {/* Section 1 — Attached bundles (plug-in / plug-out) */}
      <section className="mt-8">
        <SectionHeading
          title="Workspace bundles"
          meta={bundles.length > 0 ? `${bundles.length} available` : undefined}
        />
        {bundles.length === 0 ? (
          <EmptyState
            className="mt-3"
            title="No bundles yet"
            description="Create one below, then drop documents into it. Bundles are reusable across every agent."
          />
        ) : (
          <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-border bg-surface">
            {bundles.map((b) => {
              const attached = agent.bundleIds.includes(b.id);
              return (
                <div
                  key={b.id}
                  className="flex items-center gap-3 px-5 py-3.5 text-sm transition-colors duration-200 hover:bg-surface-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {b.documentCount} {b.documentCount === 1 ? "document" : "documents"}
                      {attached ? " · attached" : ""}
                    </div>
                  </div>
                  {/* Attaching a bundle changes what this agent knows for
                      everyone who uses it, so it is a write to a shared thing
                      even though no agent row moves. Left visible and disabled
                      rather than removed: which bundles are attached is worth
                      reading, and the state is the switch. */}
                  <Switch
                    checked={attached}
                    disabled={!canWrite}
                    onCheckedChange={(on) => toggleBundle(b.id, on)}
                    aria-label={`Attach ${b.name} to this agent`}
                  />
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => deleteBundle(b.id, b.name)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                      aria-label={`Delete bundle ${b.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2 — Manage a bundle */}
      {canWrite ? (
        <section className="mt-10 space-y-4">
          <SectionHeading title="Manage a bundle" />

          <div className="flex items-center gap-2">
            <Input
              placeholder="New bundle name"
              value={newBundleName}
              onChange={(e) => setNewBundleName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                }
              }}
              disabled={creating}
            />
            <Button type="button" onClick={create} disabled={creating || !newBundleName.trim()}>
              Create
            </Button>
          </div>

          <Select
            value={selectedBundleId ?? undefined}
            onValueChange={(v) => setSelectedBundleId(v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a bundle to manage" />
            </SelectTrigger>
            <SelectContent>
              {bundles.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedBundle && (
            <>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center transition-colors duration-200",
                  dragging
                    ? "border-accent-orange bg-surface-hover"
                    : "border-border bg-surface hover:bg-surface-hover",
                )}
              >
                <Upload
                  className={cn(
                    "h-6 w-6 transition-colors",
                    dragging ? "text-accent-orange" : "text-muted-foreground",
                  )}
                />
                <div className="font-dm text-[17px] font-medium">
                  {dragging ? "Drop to upload" : `Drop files into `}
                </div>
                <div className="text-xs text-muted-foreground">TXT, Markdown, CSV, JSON, PDF</div>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept=".md,.markdown,.txt,.csv,.json,.pdf"
                  onChange={(e) => addFiles(e.target.files)}
                />
              </label>

              {uploading.length > 0 && (
                <div className="divide-y divide-hairline overflow-hidden rounded-xl border border-border bg-surface">
                  {uploading.map((u) => (
                    <div key={u.id} className="px-5 py-3 text-sm">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{u.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {u.progress}%
                        </span>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${u.progress}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        // Creating a bundle, uploading a document, re-indexing one and
        // deleting one are all writes to what the workspace shares, and
        // can_write_in_workspace refuses every one of them for a viewer. The
        // section is replaced rather than disabled: a form with every control
        // greyed out is a worse explanation than a sentence.
        <section className="mt-10">
          <SectionHeading title="Manage a bundle" />
          <EmptyState
            className="mt-3"
            title="Read-only here"
            description="You can read every bundle attached to this agent and everything in it. Adding, uploading to and deleting bundles is a member's job — ask an admin to change your role if you need it."
          />
        </section>
      )}

      {/* Section 3 — What the agent actually reads.
          Outside the `canWrite` branch, and outside the bundle selector, because
          it answers a question neither of them is about: what does this agent
          know? `agent.documents` is every document in every bundle attached to
          it — it never was scoped to the bundle being managed, so nesting it
          under the selector hid it until an unrelated control was touched, and
          nesting it under `canWrite` hid it from the viewer whose read-only
          notice promises it. */}
      <section className="mt-10">
        <SectionHeading
          title="Documents"
          meta={
            agent.documents.length > 0
              ? `${agent.documents.length} ${agent.documents.length === 1 ? "file" : "files"}`
              : undefined
          }
        />
        {agent.documents.length === 0 ? (
          <EmptyState
            className="mt-3"
            title="No documents yet"
            description={
              canWrite
                ? "Attach a bundle above, or drop files into one, and they're chunked and embedded for retrieval in chat."
                : "Nothing is attached to this agent yet. A member can add a bundle for it to read."
            }
          />
        ) : (
          <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-border bg-surface">
            {agent.documents.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 px-5 py-3.5 text-sm transition-colors duration-200 hover:bg-surface-hover"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => api.documents.download(d.id, d.name)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate hover:underline">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(d.size / 1024).toFixed(0)} KB
                  </div>
                </button>
                {/* Amber = indexed and retrievable; neutral = not yet.
                    Two states, the system's whole chip vocabulary. */}
                {d.indexed ? (
                  <span
                    title={`${d.chunkCount} ${d.chunkCount === 1 ? "chunk" : "chunks"} embedded`}
                  >
                    <Chip tone="on">Indexed</Chip>
                  </span>
                ) : (
                  <span title="No embeddings yet — not retrievable in chat. Try reindexing.">
                    <Chip tone="neutral">Not indexed</Chip>
                  </span>
                )}
                {/* Reading a document is membership; re-embedding or deleting one
                    is `can_write_in_workspace`, so a viewer gets neither button. */}
                {canWrite && (
                  <>
                    <button
                      onClick={() => reindex(d.id, d.name)}
                      disabled={reindexing.has(d.id)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      aria-label={`Reindex ${d.name}`}
                      title="Re-embed this document"
                    >
                      <RefreshCw
                        className={cn("h-4 w-4", reindexing.has(d.id) && "animate-spin")}
                      />
                    </button>
                    <button
                      onClick={() => remove(d.id)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                      aria-label={`Remove ${d.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
