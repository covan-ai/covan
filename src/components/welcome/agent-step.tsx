import { useState, type FormEvent } from "react";
import { useAgentsStore } from "@/lib/agents-store";
import { templateForUseCase } from "@/lib/onboarding-options";
import { EMOJIS } from "@/lib/agent-meta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GeneratePersonaButton } from "@/components/generate-persona-button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * The first agent, pre-filled from what the survey learned. Smaller than
 * CreateAgentDialog on purpose: the template is already chosen, and uploading
 * documents is a thing to do once there is an agent to hang them on.
 */
export function AgentStep({
  useCase,
  defaultModel,
  onDone,
}: {
  useCase: string | null;
  defaultModel: string | null;
  onDone: () => void;
}) {
  const template = templateForUseCase(useCase);
  const { createAgent } = useAgentsStore();
  const [name, setName] = useState(template.label);
  const [emoji, setEmoji] = useState(template.emoji);
  const [persona, setPersona] = useState(template.persona);
  const [saving, setSaving] = useState(false);

  const model = defaultModel ?? template.model;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    try {
      // "normal", the same mode CreateAgentDialog starts an agent in. A
      // brainstorm agent is a deliberate later choice, not a first one.
      await createAgent({
        name: name.trim(),
        emoji,
        model,
        persona: persona.trim(),
        mode: "normal",
      });
      onDone();
    } catch {
      toast.error("Couldn't create the agent.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="agent-name">Name</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label>Icon</Label>
        <div className="flex flex-wrap gap-1.5">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`Use ${e}`}
              aria-pressed={emoji === e}
              onClick={() => setEmoji(e)}
              className={cn(
                "grid h-10 w-10 place-items-center rounded-md border text-lg transition-colors duration-200",
                "focus-visible:shadow-glow focus-visible:outline-none",
                emoji === e ? "border-border bg-surface" : "border-hairline hover:bg-surface-hover",
              )}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="agent-persona">Persona</Label>
          {/* `hasPersona` makes the button confirm before overwriting. The
              template has already filled the field, so it is always true here —
              nobody should lose a persona they were reading to a stray click. */}
          <GeneratePersonaButton
            name={name}
            model={model}
            hasPersona={persona.trim().length > 0}
            onGenerated={setPersona}
          />
        </div>
        <Textarea
          id="agent-persona"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={6}
          className="resize-none"
        />
      </div>

      <div className="space-y-2.5">
        <Button type="submit" className="w-full" disabled={saving || !name.trim()}>
          {saving ? "Creating…" : "Create agent"}
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="w-full text-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          I'll do this later
        </button>
      </div>
    </form>
  );
}
