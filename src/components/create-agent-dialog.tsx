import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { AGENT_MARKS, AgentMarkPicker } from "@/components/agent-mark";
import { GeneratePersonaButton } from "@/components/generate-persona-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import {
  NEW_AGENT_SHARING,
  NEW_AGENT_SHARING_LABEL,
  newAgentSharing,
  type NewAgentSharing,
} from "@/lib/agent-access";
import {
  formatReplyPrice,
  modelLabel,
  modelsFor,
  modelTiers,
  priceFor,
  replyPricesOf,
  startingModelFor,
} from "@/lib/agent-meta";
import { useAgentsStore } from "@/lib/agents-store";

/**
 * "New agent" (A17): one step — a name, a face, what it does, a model and
 * who can use it. Knowledge and tools are attached in Configuration once it
 * exists, which is where the thread it opens into links.
 *
 * The dialog owns nothing but whether it is open: the form mounts with it and
 * unmounts on close, so a fresh dialog is a fresh form (#68).
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
      <DialogContent size="lg">
        <CreateAgentForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateAgentForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { agents, createAgent } = useAgentsStore();
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const [name, setName] = useState("");
  // The first mark nobody here wears yet, so two new agents do not arrive
  // with the same face; the monogram once all eight are taken.
  const [avatar, setAvatar] = useState<string | null>(
    () => AGENT_MARKS.find((m) => !agents.some((a) => a.avatar === m)) ?? null,
  );
  const [persona, setPersona] = useState("");
  // Seeded once, when the form mounts with the dialog — not on every change to
  // the workspace default, which would throw away a model just picked.
  const [model, setModel] = useState<string>(() =>
    startingModelFor(me?.models, me?.workspace.defaultModel),
  );
  const [sharing, setSharing] = useState<NewAgentSharing>("only");
  const [saving, setSaving] = useState(false);

  const models = modelsFor(me?.models, model);
  const prices = replyPricesOf(me);
  const tiers = modelTiers(models);
  const option = (m: string) => {
    const price = priceFor(prices, m);
    return `${modelLabel(m)}${price ? ` · ${formatReplyPrice(price).replace(/^~/, "")}` : ""}`;
  };

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const agent = await createAgent({
        name: name.trim(),
        avatar,
        model,
        persona,
        mode: "normal",
        webSearch: true,
        sharing: newAgentSharing(sharing),
      });
      toast.success(
        sharing === "only"
          ? t("{{name}} is ready", { name: agent.name })
          : t("{{name}} is live for your team", { name: agent.name }),
      );
      onDone();
      void navigate({ to: "/agents/$agentId/chat", params: { agentId: agent.id } });
    } catch {
      toast.error(t("Couldn't create the agent"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <span className="flex flex-wrap items-baseline gap-x-3">
          <DialogTitle>{t("New agent")}</DialogTitle>
          <span className="text-meta text-muted-foreground">
            {sharing === "only"
              ? t("Only you can use it until you share it.")
              : t("The whole workspace can use it.")}
          </span>
        </span>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-[18px]">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">{t("Name")}</Label>
          <Input
            id="agent-name"
            className="h-9"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("e.g. Research")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
        </div>
        <div className="space-y-2">
          <span className="block text-sm font-medium">{t("Face")}</span>
          <AgentMarkPicker value={avatar} onChange={setAvatar} size={40} />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="agent-persona">{t("What it does")}</Label>
            <GeneratePersonaButton
              name={name}
              model={model}
              hasPersona={persona.trim().length > 0}
              onGenerated={setPersona}
            />
          </div>
          <Textarea
            id="agent-persona"
            rows={4}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder={t(
              "Who it works for, what it reads, how it speaks, what it must never do.",
            )}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("Model")}</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger aria-label={t("Model")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((t) => (
                  <SelectItem key={t.model} value={t.model}>
                    {option(t.model)}
                  </SelectItem>
                ))}
                {models
                  .filter((m) => !tiers.some((t) => t.model === m))
                  .map((m) => (
                    <SelectItem key={m} value={m}>
                      {option(m)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("Who can use it")}</Label>
            <Select value={sharing} onValueChange={(v) => setSharing(v as NewAgentSharing)}>
              <SelectTrigger aria-label={t("Who can use it")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEW_AGENT_SHARING.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {choice === "only" ? t("Only me") : NEW_AGENT_SHARING_LABEL[choice]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <span className="mr-auto hidden text-meta text-muted-foreground sm:inline">
          {t("Knowledge and tools are attached in Configuration after it exists.")}
        </span>
        <Button variant="secondary" onClick={onDone}>
          {t("Cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={!name.trim() || saving}>
          {saving ? t("Creating…") : t("Create agent")}
        </Button>
      </DialogFooter>
    </>
  );
}
