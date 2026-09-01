import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, X, FileText, ChevronRight, ChevronLeft, Sparkles } from "lucide-react";
import { useAgentsStore } from "@/lib/agents-store";
import { GeneratePersonaButton } from "@/components/generate-persona-button";
import { EMOJIS, MODELS, PERSONA_TEMPLATES } from "@/lib/agent-meta";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ALLOWED_EXT = ["md", "markdown", "txt", "csv", "json", "pdf"];
const MAX_SIZE = 10 * 1024 * 1024;

function extOf(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * The dialog itself owns nothing but whether it is open.
 *
 * Everything else lives in `CreateAgentForm` below, which `DialogContent`
 * mounts on open and unmounts on close — so a fresh dialog is a fresh
 * component, and there is no state left over to clear. That replaces two
 * things (#68): an effect that re-seeded the model whenever `open` went true,
 * with a disabled dependency rule to stop it re-running, and a `reset()` that
 * had to name all seven pieces of state and be called from both of the two
 * ways the dialog can close. Either could fall behind a field added later;
 * neither can now, because neither exists.
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <CreateAgentForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateAgentForm({ onDone }: { onDone: () => void }) {
  const { createAgent, createBundle, attachBundle, uploadToBundle } = useAgentsStore();
  const navigate = useNavigate();
  // Shares the cache the dashboard already filled, so this costs no request.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const startingModel = me?.workspace.defaultModel ?? MODELS[0];
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🧠");
  // Seeded once, when the dialog opens and this component mounts with it — not
  // on every change to the workspace default, which would throw away a model
  // the user had just picked. Templates still set their own; the model is part
  // of what a template is.
  const [model, setModel] = useState<string>(startingModel);
  const [persona, setPersona] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  // Hold the real File objects picked in the Train step. The agent doesn't
  // exist yet, so they can only be uploaded after createAgent returns an id.
  const [docs, setDocs] = useState<{ id: string; name: string; size: number; file: File }[]>([]);

  const applyTemplate = (id: string) => {
    const t = PERSONA_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    // Toggle off if the same template is tapped again.
    if (templateId === id) {
      setTemplateId(null);
      return;
    }
    setTemplateId(id);
    setEmoji(t.emoji);
    setModel(t.model);
    setPersona(t.persona);
    if (!name.trim()) setName(t.label);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted: { id: string; name: string; size: number; file: File }[] = [];
    for (const f of Array.from(files)) {
      if (!ALLOWED_EXT.includes(extOf(f.name))) {
        toast.error(`${f.name}: unsupported type (md, txt, csv, json, pdf)`);
        continue;
      }
      if (f.size > MAX_SIZE) {
        toast.error(`${f.name}: too large (max 10 MB)`);
        continue;
      }
      accepted.push({
        id: `d_${Math.random().toString(36).slice(2, 9)}`,
        name: f.name,
        size: f.size,
        file: f,
      });
    }
    if (accepted.length > 0) setDocs((prev) => [...prev, ...accepted]);
  };

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const agent = await createAgent({ name: name.trim(), emoji, model, persona, mode: "normal" });
      // Documents are bundle-scoped now. Put the Train-step files into a fresh
      // bundle named after the agent and attach it, so they're retrievable in
      // chat. Don't fail agent creation if bundle setup or a doc upload fails;
      // the agent exists and the user can retry from the Knowledge tab.
      if (docs.length > 0) {
        let bundleId: string | null = null;
        try {
          const bundle = await createBundle(`${name.trim()} knowledge`);
          bundleId = bundle.id;
          attachBundle(agent.id, bundle.id);
        } catch {
          bundleId = null;
        }
        if (!bundleId) {
          toast.error(
            `${name.trim()} created, but its knowledge bundle couldn't be set up. Add documents from the Knowledge tab.`,
          );
        } else {
          const bid = bundleId;
          const results = await Promise.allSettled(docs.map((d) => uploadToBundle(bid, d.file)));
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed > 0) {
            toast.error(
              `${name.trim()} created, but ${failed} document${failed === 1 ? "" : "s"} failed to upload. Retry from the Knowledge tab.`,
            );
          } else {
            toast.success(`${name.trim()} is live for your team`);
          }
        }
      } else {
        toast.success(`${name.trim()} is live for your team`);
      }
      onDone();
      navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    } catch {
      toast.error("Couldn't create agent");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create agent</DialogTitle>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <StepDot n={1} active={step === 1} done={step > 1} label="Configure" />
          <div className="h-px w-6 bg-border" />
          <StepDot n={2} active={step === 2} done={false} label="Train" />
        </div>
      </DialogHeader>

      {step === 1 ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
              Start from a template
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {PERSONA_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium transition-colors duration-200",
                    // Selection is a filled ink chip. Amber marks state that
                    // is live in the product, not a transient UI selection.
                    templateId === t.id
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span className="text-sm leading-none">{t.emoji}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-3">
            <div className="flex flex-col gap-2">
              <Label className="text-xs">Icon</Label>
              <Select value={emoji} onValueChange={setEmoji}>
                <SelectTrigger className="w-16 text-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMOJIS.map((e) => (
                    <SelectItem key={e} value={e} className="text-lg">
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-xs" htmlFor="agent-name">
                Name
              </Label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Growth Copywriter"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="persona">
                Persona / system prompt
              </Label>
              <GeneratePersonaButton
                name={name}
                model={model}
                hasPersona={persona.trim().length > 0}
                onGenerated={(p) => {
                  setPersona(p);
                  setTemplateId(null);
                }}
              />
            </div>
            <Textarea
              id="persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="You are a senior…"
              rows={5}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <label
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-10 text-center transition-colors hover:bg-accent/40",
            )}
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <div className="text-sm font-medium">Drop files or click to upload</div>
            <div className="text-xs text-muted-foreground">TXT, Markdown, CSV, JSON, PDF</div>
            <input
              type="file"
              multiple
              className="hidden"
              accept=".md,.markdown,.txt,.csv,.json,.pdf"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
          {docs.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs">Knowledge base ({docs.length})</Label>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {docs.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{d.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(d.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      onClick={() => setDocs((p) => p.filter((x) => x.id !== d.id))}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-between">
        {step === 2 ? (
          <Button variant="ghost" onClick={() => setStep(1)}>
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>
        ) : (
          <div />
        )}
        {step === 1 ? (
          <Button onClick={() => setStep(2)} disabled={!name.trim()}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={save} disabled={saving}>
            {saving ? "Publishing…" : "Save & publish"}
          </Button>
        )}
      </div>
    </>
  );
}

function StepDot({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          "grid h-5 w-5 place-items-center rounded-sm text-xs font-medium",
          active || done
            ? "bg-accent-orange text-accent-orange-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {n}
      </div>
      <span className={cn(active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </div>
  );
}
