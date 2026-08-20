import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAgentsStore } from "@/lib/agents-store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { EMOJIS, MODELS } from "@/lib/agent-meta";
import { PageContainer, PageHeader, PanelEyebrow } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { AgentAvatar } from "@/components/avatars";
import { GeneratePersonaButton } from "@/components/generate-persona-button";

export const Route = createFileRoute("/_authed/agents/$agentId/configuration")({
  component: ConfigurationTab,
});

function ConfigurationTab() {
  const { agentId } = Route.useParams();
  const { agents, updateAgent } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId)!;

  const [name, setName] = useState(agent.name);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [model, setModel] = useState(agent.model);
  const [persona, setPersona] = useState(agent.persona);
  const [mode, setMode] = useState(agent.mode);

  useEffect(() => {
    setName(agent.name);
    setEmoji(agent.emoji);
    setModel(agent.model);
    setPersona(agent.persona);
    setMode(agent.mode);
  }, [agent.id]);

  const save = () => {
    updateAgent(agent.id, { name: name.trim() || agent.name, emoji, model, persona, mode });
    toast.success("Configuration saved");
  };

  return (
    <PageContainer width="list">
      <PageHeader badge="Configuration" title="One persona." turn="Every conversation." />

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        <SectionCard className="space-y-5">
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
              <Label className="text-xs" htmlFor="a-name">
                Name
              </Label>
              <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} />
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
            <Label className="text-xs">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "normal" | "brainstorm")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="brainstorm">🧠 Brainstorm</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Brainstorm mode makes this agent generate and pressure-test ideas instead of answering
              directly — good for finding new directions.
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="a-persona">
                Persona / system prompt
              </Label>
              <GeneratePersonaButton
                name={name}
                model={model}
                hasPersona={persona.trim().length > 0}
                onGenerated={setPersona}
              />
            </div>
            <Textarea
              id="a-persona"
              rows={8}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Applied to every private conversation your team has with this agent.
            </p>
          </div>
          <div className="flex justify-end border-t border-hairline pt-4">
            <Button onClick={save}>Save changes</Button>
          </div>
        </SectionCard>

        <PersonaPreview emoji={emoji} name={name || agent.name} model={model} persona={persona} />
      </div>
    </PageContainer>
  );
}

function PersonaPreview({
  emoji,
  name,
  model,
  persona,
}: {
  emoji: string;
  name: string;
  model: string;
  persona: string;
}) {
  const trimmed = persona.trim();
  const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] || trimmed;
  const reply =
    trimmed.length === 0
      ? "Add a persona to see how I'll introduce myself."
      : `Hi! ${firstSentence} How can I help you today?`;

  return (
    // A product panel (§7.7): white, the one panel shadow, a window-chrome bar,
    // and an interior that sits one step below on the canvas colour.
    <div className="overflow-hidden rounded-3xl bg-popover shadow-card lg:sticky lg:top-6">
      <div className="flex items-center gap-[7px] border-b border-hairline bg-surface-muted px-[18px] py-3.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#d4cdc7] dark:bg-[#453b31]" />
        <span className="ml-2.5 text-[13px] font-medium text-muted-foreground">Preview</span>
      </div>
      <div className="flex flex-col gap-3 px-5 py-5">
        <PanelEyebrow>{model}</PanelEyebrow>
        {/* Three 14px corners and one 4px corner on the speaker's side. */}
        <div className="self-end rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-[15px] leading-[1.45] text-primary-foreground">
          How can you help?
        </div>
        <div className="flex items-start gap-2.5">
          <AgentAvatar emoji={emoji} className="mt-0.5 h-6 w-6 text-xs" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-muted-foreground">{name}</div>
            <div className="mt-1 whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-surface px-4 py-3 text-[15px] leading-[1.45]">
              {reply}
            </div>
          </div>
        </div>
      </div>
      <p className="border-t border-hairline px-5 py-3 text-[13px] leading-[1.45] text-muted-foreground">
        Illustrative only — updates as you type.
      </p>
    </div>
  );
}
