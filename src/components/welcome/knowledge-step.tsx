import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { validateUpload } from "@/lib/uploads";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * The first document, asked for while the agent is still the thing on screen.
 *
 * This step exists because of what the run used to end in. An agent was
 * created, the flow finished, and the first question was answered out of the
 * model's general knowledge — which is the one thing Covan is not for. The
 * product's claim is a colleague who has read what your team wrote down, and
 * nothing on the way in ever asked for anything to read.
 *
 * Skippable, and the skip is not a lesser path: someone whose documents live on
 * a colleague's laptop cannot produce one at signup, and asking twice would not
 * change that.
 */

type Picked = { id: string; name: string; size: number; file: File };

/**
 * Where the files go. The bundle is named after the agent rather than something
 * generic, because bundles are reusable across agents and a workspace with
 * three of them wants to be able to tell them apart later.
 */
function bundleNameFor(agentName: string): string {
  return `${agentName} knowledge`;
}

export function KnowledgeStep({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const { createBundle, uploadToBundle } = useAgentsStore();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted: Picked[] = [];
    for (const file of Array.from(files)) {
      // The same gate the Knowledge tab and the chat composer use, so a file
      // refused here would have been refused there too.
      const check = validateUpload(file);
      if (!check.ok) {
        toast.error(check.reason);
        continue;
      }
      accepted.push({
        id: `d_${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        size: file.size,
        file,
      });
    }
    if (accepted.length > 0) setPicked((prev) => [...prev, ...accepted]);
  };

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    // Nothing picked is the same answer as the skip link below.
    if (picked.length === 0) {
      onDone();
      return;
    }

    setSaving(true);
    try {
      const bundle = await createBundle(bundleNameFor(agent.name));
      // Awaited, unlike the store's fire-and-forget `attachBundle`. A bundle
      // that is not attached when the run ends is a document the agent cannot
      // read, and the whole point of this step is that it can.
      await api.bundles.attach(agent.id, bundle.id);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });

      const results = await Promise.allSettled(
        picked.map((p) => uploadToBundle(bundle.id, p.file)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const unindexed = results.filter((r) => r.status === "fulfilled" && !r.value.indexed).length;

      if (failed === picked.length) {
        toast.error("Couldn't upload those. You can add them from the Knowledge tab.");
      } else if (failed > 0) {
        toast.warning(
          `Uploaded the rest, but ${failed} file${failed === 1 ? "" : "s"} failed. Retry from the Knowledge tab.`,
        );
      } else if (unindexed > 0) {
        // The same lie in the other direction: these uploaded and stored fine,
        // and no answer will ever be grounded in them. Say so here, because
        // this screen forwards straight into the app and there is no second
        // chance to notice.
        toast.warning(
          unindexed === picked.length
            ? "Uploaded, but nothing could be indexed — answers won't be grounded in these yet."
            : `Uploaded, but ${unindexed} of ${picked.length} couldn't be indexed. Retry from the Knowledge tab.`,
        );
      } else {
        // Deliberately not "indexed": the reply may still be a moment away, and
        // promising a thing that has not finished is how this screen would lie.
        toast.success(picked.length === 1 ? "Document added" : `${picked.length} documents added`);
      }
    } catch {
      toast.error("Couldn't set up the knowledge bundle. Add documents from the Knowledge tab.");
    }
    // Forward either way. A failed upload is a thing to retry on a screen built
    // for it, not a reason to hold someone on the last step of a signup.
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="welcome-files">Documents for {agent.name}</Label>
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
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center transition-colors duration-200",
            dragging
              ? "border-accent-orange bg-surface-hover"
              : "border-border bg-surface hover:bg-surface-hover",
          )}
        >
          <Upload
            className={cn(
              "h-6 w-6 transition-colors duration-200",
              dragging ? "text-accent-orange" : "text-muted-foreground",
            )}
          />
          <span className="text-sm text-muted-foreground">
            {dragging ? "Drop to add" : "Drop files here, or click to choose"}
          </span>
          <span className="text-xs text-micro-foreground">
            md, txt, csv, json, pdf · up to 10 MB
          </span>
          <input
            id="welcome-files"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              // Cleared so picking the same file twice in a row still fires.
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {picked.length > 0 && (
        <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-border bg-surface">
          {picked.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {(p.size / 1024).toFixed(0)} KB
              </span>
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2.5">
        <Button type="submit" className="w-full" disabled={saving}>
          {saving
            ? "Uploading…"
            : picked.length === 0
              ? "Continue"
              : `Add ${picked.length} ${picked.length === 1 ? "document" : "documents"}`}
        </Button>
        <button
          type="button"
          onClick={onDone}
          disabled={saving}
          className="w-full text-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          I'll add documents later
        </button>
      </div>
    </form>
  );
}
