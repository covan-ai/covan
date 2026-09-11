import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import {
  PageContainer,
  PageHeader,
  PanelEyebrow,
  SectionHeading,
} from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  EMOJIS,
  modelsFor,
  specFor,
  REASONING_EFFORTS,
  REASONING_EFFORT_HINTS,
  type ReasoningEffort,
} from "@/lib/agent-meta";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentAvatar } from "@/components/avatars";
import { GeneratePersonaButton } from "@/components/generate-persona-button";

export const Route = createFileRoute("/_authed/agents/$agentId/settings")({
  component: SettingsTab,
});

/**
 * Everything about one agent, on one page.
 *
 * This used to be two tabs: "Configuration" held every editable field, while
 * "Settings" held three read-only facts and the delete button. People looking
 * for the name or the model reasonably opened Settings and found neither.
 * Ordered by how often it is touched — the fields, then the facts, then the
 * button nobody presses twice.
 */
function SettingsTab() {
  const { agentId } = Route.useParams();
  const { agents } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId)!;

  // Switching to a different agent remounts the form, which is the only event
  // that should discard a half-typed edit.
  //
  // This replaces an effect that copied the five fields into state whenever
  // `agent.id` changed, with a disable for the exhaustive-deps rule and a
  // paragraph explaining that adding the other five dependencies would be a
  // bug — any refresh of the store (the write-back from `save`, another tab, a
  // realtime update) would have run it again and thrown away what you had
  // typed. All of that reasoning survives; `key` is just the spelling of it
  // React can enforce, and it does not need an effect, a disable, or a comment
  // asking the next person not to "fix" the dependency array. #68.
  return <AgentSettingsForm key={agent.id} agent={agent} />;
}

function AgentSettingsForm({ agent }: { agent: Agent }) {
  const { updateAgent, deleteAgent, canWrite } = useAgentsStore();
  const navigate = useNavigate();

  const [name, setName] = useState(agent.name);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [model, setModel] = useState(agent.model);
  const [persona, setPersona] = useState(agent.persona);
  // Shares the cache every authed page has already filled, so this costs no
  // request. `me.models` is the list this deployment can actually serve — the
  // Claude ids are in it only when the server has a key for them.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const models = modelsFor(me?.models, model);
  const [mode, setMode] = useState(agent.mode);
  // Null is Auto, and Auto is what every agent starts on: the mode decides.
  // `?? null` rather than a default, because an API older than this screen
  // sends neither field and "the server did not say" is the same answer.
  const [temperature, setTemperature] = useState<number | null>(agent.temperature ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(
    agent.reasoningEffort ?? null,
  );
  // What the *currently picked* model accepts, not what the saved one did — so
  // switching to gpt-5 in this form greys the temperature out before you save,
  // rather than after the reply comes back wrong.
  const spec = specFor(me?.modelSpecs, model);

  const save = () => {
    updateAgent(agent.id, {
      name: name.trim() || agent.name,
      emoji,
      model,
      persona,
      mode,
      temperature,
      reasoningEffort,
    });
    toast.success("Changes saved");
  };

  return (
    <PageContainer width="list">
      <PageHeader badge="Agent settings" title="One persona." turn="Every conversation." />

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        <SectionCard className="space-y-5">
          {/* One disabled fieldset rather than a `disabled` on each control:
              the browser disables every form element inside it, so a control
              added here later is covered without anybody remembering to. It
              needs `display: contents` so SectionCard's own spacing still sees
              these as its children. */}
          <fieldset disabled={!canWrite} className="contents">
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
                  {models.map((m) => (
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
                Brainstorm mode makes this agent generate and pressure-test ideas instead of
                answering directly — good for finding new directions.
              </p>
            </div>
            <TemperatureField
              value={temperature}
              onChange={setTemperature}
              accepted={spec.temperature}
              model={model}
            />
            <ReasoningField
              value={reasoningEffort}
              onChange={setReasoningEffort}
              accepted={spec.reasoning}
              model={model}
            />
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
          </fieldset>
          <div className="flex justify-end border-t border-hairline pt-4">
            {canWrite ? (
              <Button onClick={save}>Save changes</Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                This is how the agent is set up. Changing it is a member's job.
              </p>
            )}
          </div>
        </SectionCard>

        <PersonaPreview emoji={emoji} name={name || agent.name} model={model} persona={persona} />
      </div>

      <section className="mt-14">
        <SectionHeading title="Details" />
        <SectionCard padded={false} className="mt-3 overflow-hidden">
          <dl className="divide-y divide-hairline">
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Agent ID</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-xs">{agent.id}</dd>
            </div>
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Created</dt>
              <dd className="min-w-0 flex-1 truncate text-sm">
                {new Date(agent.createdAt).toLocaleString()}
              </dd>
            </div>
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Visibility</dt>
              <dd className="min-w-0 flex-1 truncate text-sm">Shared with the whole workspace</dd>
            </div>
          </dl>
        </SectionCard>
      </section>

      {canWrite && (
        <section className="mt-10">
          <SectionHeading
            title="Danger zone"
            description="Deleting the agent takes it away from the entire team, along with everyone's private chats. Recoverable for 30 days."
          />
          <SectionCard className="mt-3 flex items-center justify-between gap-4 border-destructive/30">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Delete {agent.name}</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Recoverable for 30 days from Settings.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  Delete agent
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This takes the shared agent away from the whole team, along with every chat and
                    routine attached to it. It waits 30 days in Settings → Recently deleted, and
                    comes back whole if you restore it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      deleteAgent(agent.id);
                      toast.success("Agent deleted");
                      navigate({ to: "/app" });
                    }}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SectionCard>
        </section>
      )}
    </PageContainer>
  );
}

/**
 * How much the model may vary its wording.
 *
 * Two controls for one setting, because the setting has a state that is not a
 * number. Auto is not 0.7 or any other value — it means the mode decides, which
 * is 0.9 in brainstorm and *nothing sent at all* in normal chat, and no point
 * on a 0-to-2 slider can say that. So the checkbox chooses between "the mode
 * decides" and "I decide", and the slider only exists in the second case.
 *
 * A native range input rather than a slider component: there is no slider in
 * `components/ui`, and one control does not justify a Radix dependency and a
 * lockfile change. The thumb is squared off and amber because DESIGN.md says
 * selection markers are squares and the accent is the pointer.
 */
function TemperatureField({
  value,
  onChange,
  accepted,
  model,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  accepted: boolean;
  model: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs" htmlFor="a-temperature">
          Temperature
        </Label>
        <div className="flex items-center gap-2">
          <Checkbox
            id="a-temperature-auto"
            checked={value === null}
            disabled={!accepted}
            // 0.7 on first touch rather than 0: a slider that starts at one end
            // reads as "off", and the number somebody wants is almost never the
            // extreme they landed on.
            onCheckedChange={(checked) => onChange(checked === true ? null : 0.7)}
          />
          <Label className="text-xs font-normal text-muted-foreground" htmlFor="a-temperature-auto">
            Auto
          </Label>
        </div>
      </div>
      {value !== null && (
        <div className="flex items-center gap-3">
          <input
            id="a-temperature"
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={value}
            disabled={!accepted}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-muted accent-primary outline-none disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-[4px] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#f48d16] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[4px] [&::-webkit-slider-thumb]:bg-[#f48d16]"
          />
          <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums">
            {value.toFixed(1)}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {!accepted ? (
          <>
            <span className="font-mono">{model}</span> decides this for itself and rejects any other
            value, so the agent runs on its own setting.
          </>
        ) : value === null ? (
          "Left to the mode: steady in Normal, wide-ranging in Brainstorm."
        ) : value <= 0.3 ? (
          "Close to the same answer every time. Good for support and policy questions."
        ) : value <= 1 ? (
          "Some variation in wording, the same substance."
        ) : (
          "Freely inventive, and less predictable. Worth checking what it says."
        )}
      </p>
    </div>
  );
}

/**
 * How long the agent thinks before it starts writing.
 *
 * Auto is a real option and the one every agent is on — it sends no effort at
 * all and lets the model do what it does. "Medium" is a different request, so
 * the two cannot be collapsed into one item however similar they look.
 *
 * Shown rather than hidden on a model that does not reason. The picker above it
 * is the thing that decides whether this control does anything, and a setting
 * that vanishes when you change a neighbouring field reads as a bug; a disabled
 * one that says why reads as an explanation.
 */
function ReasoningField({
  value,
  onChange,
  accepted,
  model,
}: {
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  accepted: boolean;
  model: string;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">Reasoning</Label>
      <Select
        value={value ?? AUTO}
        disabled={!accepted}
        onValueChange={(v) => onChange(v === AUTO ? null : (v as ReasoningEffort))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>Auto</SelectItem>
          {REASONING_EFFORTS.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {effort[0].toUpperCase() + effort.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {!accepted ? (
          <>
            <span className="font-mono">{model}</span> answers without a separate thinking step, so
            this has no effect on it.
          </>
        ) : value === null ? (
          "Whatever the model does by default."
        ) : (
          REASONING_EFFORT_HINTS[value]
        )}
      </p>
    </div>
  );
}

/**
 * The picker's stand-in for null. A `Select` item cannot carry an empty value —
 * Radix reserves it for "nothing is selected", which is not what Auto means.
 */
const AUTO = "auto";

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
