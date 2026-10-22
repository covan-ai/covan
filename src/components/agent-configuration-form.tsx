import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AgentFoldersDialog } from "@/components/agent-folders-dialog";
import { AgentMark, AgentMarkPicker } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { DeleteAgentDialog } from "@/components/delete-agent-dialog";
import { Disclosure } from "@/components/disclosure";
import { Field } from "@/components/field";
import { GeneratePersonaButton } from "@/components/generate-persona-button";
import { AllModels, ModelPicker } from "@/components/model-picker";
import { PageBody } from "@/components/page";
import { SavedLoginsList } from "@/components/saved-logins";
import { SectionLabel } from "@/components/section";
import { ShareAgentDialog } from "@/components/share-agent-dialog";
import { TopBarPortal } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToolConnections } from "@/hooks/use-connections";
import { api } from "@/lib/api-client";
import {
  ACCESS_LABEL,
  canEditAgent,
  canManageAgent,
  whoCanEdit,
  whoCanUse,
} from "@/lib/agent-access";
import {
  EFFORT_WORDS,
  modelsFor,
  REASONING_EFFORTS,
  replyPricesOf,
  specFor,
  type ReasoningEffort,
} from "@/lib/agent-meta";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { lastActivityLabel } from "@/lib/day-groups";
import { isAdminRole } from "@/lib/roles";

/** A `Select` item cannot carry an empty value; this stands in for Auto. */
const AUTO = "auto";

type Draft = {
  name: string;
  avatar: string | null;
  persona: string;
  model: string;
  temperature: number | null;
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean;
  browserOff: boolean;
  connectionsOff: string[];
};

function draftOf(agent: Agent): Draft {
  return {
    name: agent.name,
    avatar: agent.avatar ?? null,
    persona: agent.persona,
    model: agent.model,
    temperature: agent.temperature ?? null,
    reasoningEffort: agent.reasoningEffort ?? null,
    webSearch: agent.webSearch,
    browserOff: agent.browserOff ?? false,
    connectionsOff: agent.connectionsOff ?? [],
  };
}

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An agent's Configuration (A10): Identity, Model, Knowledge, Tools, Sharing,
 * Saved sign-ins and Danger, as `Field` rows under section labels. One draft
 * for the whole page, saved or discarded from the top bar — "Saved 2 min ago ·
 * Discard · Save changes".
 *
 * What the screen offers follows the caller's access to THIS agent (0104):
 * Can use sees it as it is, Can edit changes it, Full access also shares and
 * deletes. The server refuses the rest either way.
 */
export function AgentConfigurationForm({ agent }: { agent: Agent }) {
  const { updateAgent, deleteAgent, bundles, canWrite } = useAgentsStore();
  const navigate = useNavigate();
  const canEdit = canEditAgent(agent);
  const canManage = canManageAgent(agent);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: endpoints = [] } = useQuery({
    queryKey: ["model-endpoints"],
    queryFn: api.modelEndpoints.list,
  });
  const tools = useToolConnections();

  const [saved, setSaved] = useState<Draft>(() => draftOf(agent));
  const [draft, setDraft] = useState<Draft>(saved);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [choosingFace, setChoosingFace] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = !same(draft, saved);

  const models = modelsFor(me?.models, draft.model);
  const prices = replyPricesOf(me);
  // What the *picked* model accepts, not the saved one — so a switch greys
  // the controls it makes pointless before anybody saves.
  const spec = specFor(me?.modelSpecs, draft.model);
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  const isAdmin = me ? isAdminRole(myRole) : false;
  const nameOf = (id: string) => me?.members.find((m) => m.id === id)?.name ?? null;
  const workspaceName = me?.workspace.name ?? "the workspace";
  const connections = (tools.data?.connections ?? []).filter((c) => c.status === "active");
  const folders = bundles.filter((b) => agent.bundleIds.includes(b.id));

  const save = () => {
    const next = { ...draft, name: draft.name.trim() || agent.name };
    updateAgent(agent.id, next);
    setSaved(next);
    setDraft(next);
    setSavedAt(Date.now());
    toast.success("Changes saved");
  };

  return (
    <>
      {canEdit ? (
        <TopBarPortal>
          <span className="hidden text-meta text-muted-foreground sm:inline">
            {dirty ? "Unsaved changes" : savedAt ? `Saved ${lastActivityLabel(savedAt)}` : ""}
          </span>
          <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button disabled={!dirty} onClick={save}>
            Save changes
          </Button>
        </TopBarPortal>
      ) : null}

      <PageBody width="agent" className="lg:pt-2">
        {!canEdit ? (
          <p className="mt-5 mb-0 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
            {canWrite
              ? "This is how the agent is set up. Changing it takes Can edit, which its owner or an admin can give you."
              : "This is how the agent is set up. Changing it is a member's job."}
          </p>
        ) : null}

        <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
          <SectionLabel className="mt-5">Identity</SectionLabel>
          <Field label="Name" help="How the team addresses it. Short works best." htmlFor="a-name">
            <Input
              id="a-name"
              className="max-w-[420px]"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Face" help="One of eight marks, or two letters from the name. No emoji.">
            <div className="flex items-center gap-3">
              <AgentMark agent={{ name: draft.name, avatar: draft.avatar }} size={36} />
              <Button size="sm" variant="secondary" onClick={() => setChoosingFace(true)}>
                Change
              </Button>
            </div>
          </Field>
          <Field
            label="Persona"
            help="What it is for, how it speaks, what it must never do. The team sees this when they share it."
            htmlFor="a-persona"
          >
            <Textarea
              id="a-persona"
              rows={6}
              value={draft.persona}
              onChange={(e) => set("persona", e.target.value)}
            />
            {canEdit ? (
              <div className="mt-2 flex items-center gap-2">
                <GeneratePersonaButton
                  name={draft.name}
                  model={draft.model}
                  hasPersona={draft.persona.trim().length > 0}
                  onGenerated={(persona) => set("persona", persona)}
                />
                {prices?.unit === "credits" ? (
                  <span className="text-xs text-muted-foreground">Uses one credit</span>
                ) : null}
              </div>
            ) : null}
          </Field>

          <SectionLabel>Model</SectionLabel>
          <Field
            label="Default model"
            help="Three tiers, or one specific model. The team can switch per message from the composer."
          >
            <ModelPicker
              value={draft.model}
              onChange={(m) => set("model", m)}
              models={models}
              prices={prices}
              endpoints={endpoints}
              disabled={!canEdit}
            />
          </Field>
          <Field
            label="All models"
            help="Everything this install serves. Add a custom endpoint for a self-hosted or OpenAI-compatible model."
          >
            <AllModels
              models={models}
              prices={prices}
              endpoints={endpoints}
              value={draft.model}
              canAdd={isAdmin}
            />
          </Field>
          <Field
            label="Thinking"
            help="How long it reasons before answering. Extended costs more and is slower; the team can change it per message."
          >
            <Select
              value={draft.reasoningEffort ?? AUTO}
              disabled={!spec.reasoning}
              onValueChange={(v) =>
                set("reasoningEffort", v === AUTO ? null : (v as ReasoningEffort))
              }
            >
              <SelectTrigger aria-label="Thinking" className="max-w-[420px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>Auto</SelectItem>
                {REASONING_EFFORTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EFFORT_WORDS[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!spec.reasoning ? (
              <p className="mt-2 mb-0 text-meta text-muted-foreground">
                <span className="font-mono">{draft.model}</span> answers without a separate thinking
                step, so this has no effect on it.
              </p>
            ) : null}
            <Disclosure label="Temperature" className="mt-3">
              <TemperatureField
                value={draft.temperature}
                onChange={(t) => set("temperature", t)}
                accepted={spec.temperature}
                model={draft.model}
              />
            </Disclosure>
          </Field>

          <SectionLabel>Knowledge</SectionLabel>
          <Field
            label="Folders it can read"
            help="Everything in these folders, including what a connected source syncs into them."
          >
            <div className="flex flex-wrap items-center gap-2">
              {folders.map((b) => (
                <Link key={b.id} to="/knowledge">
                  <Chip>{b.name}</Chip>
                </Link>
              ))}
              {folders.length === 0 ? (
                <span className="text-sm text-muted-foreground">None yet.</span>
              ) : null}
              {canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => setFoldersOpen(true)}>
                  Attach folder
                </Button>
              ) : null}
            </div>
          </Field>

          <SectionLabel>Tools</SectionLabel>
          <Field
            label="What it may use"
            help="Each one it uses is logged in the thread as a step. Turned off here, it is not offered at all."
          >
            <ul className="m-0 max-w-[560px] list-none p-0">
              <ToolRow
                name="Browser"
                note="Opens pages and saved sign-ins. Asks before each task in a thread."
                checked={!draft.browserOff}
                onChange={(on) => set("browserOff", !on)}
              />
              {connections.map((c) => (
                <ToolRow
                  key={c.id}
                  name={c.label}
                  note={
                    c.transport === "composio"
                      ? `${c.toolkitSlug ?? "Connected app"} · asks before its first action`
                      : `${c.transport === "http" ? "HTTP API" : "Database"} · ${
                          c.allowedMethods.some((m) => !["GET", "HEAD"].includes(m))
                            ? "can write"
                            : "read only"
                        }`
                  }
                  checked={!draft.connectionsOff.includes(c.id)}
                  onChange={(on) =>
                    set(
                      "connectionsOff",
                      on
                        ? draft.connectionsOff.filter((id) => id !== c.id)
                        : [...draft.connectionsOff, c.id],
                    )
                  }
                />
              ))}
              <ToolRow
                name="Web search"
                note={
                  spec.webSearch
                    ? "When the team's documents don't have the answer"
                    : `${draft.model} cannot search the web`
                }
                checked={draft.webSearch}
                disabled={!spec.webSearch}
                onChange={(on) => set("webSearch", on)}
              />
            </ul>
            <p className="mt-2 mb-0 text-meta text-muted-foreground">
              Connect more under{" "}
              <Link to="/settings/integrations" className="underline underline-offset-4">
                Integrations
              </Link>
              .
            </p>
          </Field>
        </fieldset>

        <SectionLabel>Sharing</SectionLabel>
        <Field
          label="Who can use it"
          help="Threads stay private to whoever starts them either way."
        >
          <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
            <span>{whoCanUse(agent, workspaceName, me?.user.id)}</span>
            {canManage ? (
              <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>
                Share
              </Button>
            ) : null}
          </div>
        </Field>
        <Field label="Who can edit it" help="Change the persona, tools and knowledge.">
          <span className="block pt-1 text-sm">
            {whoCanEdit(agent, workspaceName, nameOf, me?.user.id)}
          </span>
        </Field>
        <Field label="Your access">
          <span className="block pt-1 text-sm">{ACCESS_LABEL[agent.myAccess]}</span>
        </Field>

        <SectionLabel>Saved sign-ins</SectionLabel>
        <SavedLoginsList
          agentId={agent.id}
          empty="None yet. When a browser task stops at a login, you can save one from the browser beside the thread. Encrypted; Covan's AI model is never given them."
        />

        {canManage ? (
          <>
            <SectionLabel>Danger</SectionLabel>
            <Field label="Delete agent" help="Its threads stay readable for 30 days, then go.">
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Delete {agent.name}…
              </Button>
            </Field>
          </>
        ) : null}

        <Field label="Agent ID" help="For support requests and the API." className="mt-6">
          <Chip tone="code">{agent.id}</Chip>
        </Field>
      </PageBody>

      <Dialog open={choosingFace} onOpenChange={setChoosingFace}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Choose a face</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <AgentMarkPicker
              value={draft.avatar}
              onChange={(mark) => set("avatar", mark)}
              size={40}
            />
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                set("avatar", null);
                setChoosingFace(false);
              }}
            >
              Use letters
            </Button>
            <Button onClick={() => setChoosingFace(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentFoldersDialog agent={agent} open={foldersOpen} onOpenChange={setFoldersOpen} />
      {canManage ? (
        <>
          <ShareAgentDialog agent={agent} open={shareOpen} onOpenChange={setShareOpen} />
          <DeleteAgentDialog
            agent={agent}
            open={deleting}
            onOpenChange={setDeleting}
            onDelete={() => {
              deleteAgent(agent.id);
              toast.success("Agent deleted");
              void navigate({ to: "/app" });
            }}
          />
        </>
      ) : null}
    </>
  );
}

function ToolRow({
  name,
  note,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  note: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-b-0">
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={name} />
      <span className="text-sm font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-right text-meta text-muted-foreground">
        {note}
      </span>
    </li>
  );
}

/**
 * How much the model may vary its wording. Auto is not a point on the slider —
 * it means the mode decides, which is 0.9 in brainstorm and nothing sent at
 * all in normal chat — so the checkbox chooses between "the mode decides" and
 * "I decide", and the slider only exists in the second case.
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
    <div className="space-y-2 text-foreground">
      <div className="flex items-center gap-2">
        <Checkbox
          id="a-temperature-auto"
          checked={value === null}
          disabled={!accepted}
          // 0.7 on first touch rather than 0: a slider that starts at one end
          // reads as "off".
          onCheckedChange={(checked) => onChange(checked === true ? null : 0.7)}
        />
        <Label className="text-meta font-normal" htmlFor="a-temperature-auto">
          Auto
        </Label>
      </div>
      {value !== null && (
        <div className="flex max-w-[360px] items-center gap-3">
          <input
            id="a-temperature"
            aria-label="Temperature"
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={value}
            disabled={!accepted}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface accent-primary outline-none disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
          />
          <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums">
            {value.toFixed(1)}
          </span>
        </div>
      )}
      <p className="m-0 text-meta text-muted-foreground">
        {!accepted ? (
          <>
            <span className="font-mono">{model}</span> decides this for itself and rejects any other
            value.
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
