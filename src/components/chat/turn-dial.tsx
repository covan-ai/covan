import { memo, useState, type ReactNode } from "react";
import { Brain, ChevronDown, Globe, Lightbulb } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PromptInputAction } from "@/components/prompt-kit/prompt-input";
import { ModelCost } from "@/components/model-cost";
import {
  DIAL_EFFORTS,
  DIAL_EFFORT_HINTS,
  effortWord,
  modelLabel,
  modelTiers,
  priceFor,
  specFor,
  thinkingOf,
  type ModelSpec,
  type ReasoningEffort,
  type ReplyPrices,
} from "@/lib/agent-meta";
import type { ChatSession, SessionTuning } from "@/lib/agents-store";
import { cn } from "@/lib/utils";

/**
 * The dial beside the question: how THIS conversation is answered.
 *
 * Four chips in the composer — model, thinking, mode, web — each opening a
 * small menu, and each choice stored on the conversation rather than on the
 * agent. The shape is borrowed on purpose: the thread is where somebody finds
 * out a question is harder than the agent was set up for, and the composer is
 * where they are when they find out. Sending them to the agent's settings to
 * change it for everybody, then back to change it back, is the detour this
 * removes.
 *
 * Presentational, the same discipline as `answer-controls.tsx`: it takes the
 * conversation's four stored values and the agent's four, works out what each
 * chip says, and hands back a patch. It does not know about queries, the
 * server or toasts — the route does.
 *
 * WHAT A CHIP SHOWS IS THE VALUE IN FORCE, not the value stored. A conversation
 * that has never been tuned stores four nulls, and four chips reading "Auto"
 * would tell somebody nothing about what is about to answer them. So each chip
 * resolves the null to the agent's setting, and the menu is where "Auto
 * (agent's)" is spelled out and can be chosen back. The one exception is
 * thinking when the agent has no effort either: there the model's own default
 * is the truth, and "Auto" is the honest word for it.
 *
 * Neutral chips, and the model one in the code tone, as every model id in the
 * product is. No amber anywhere on the dial: the amber on this row is the send
 * button, and a fifth amber pointer beside it would point at nothing.
 *
 * Every chip is a menu rather than a switch — web search included, which could
 * have been a toggle — so all four are read and operated the same way, and so
 * every one of them carries a third position: back to the agent's.
 */

type DialSession = Pick<ChatSession, "kind" | "model" | "reasoningEffort" | "webSearch" | "mode">;

type DialAgent = {
  model: string;
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean;
  mode: "normal" | "brainstorm";
};

export type TurnDialProps = {
  session: DialSession;
  agent: DialAgent;
  /** What the model menu offers — `modelsFor(me.models, agent.model)`. */
  models: string[];
  /** What each costs per reply, in the unit the server answers in — `replyPricesOf(me)`. */
  prices: ReplyPrices | undefined;
  modelSpecs: Record<string, ModelSpec> | undefined;
  /** Whether this person may change the conversation: its owner, and nobody else. */
  canTune: boolean;
  /** A reply is running. The dial waits for it rather than changing under it. */
  busy: boolean;
  /** A phone: the chips drop their words and keep their values. */
  compact: boolean;
  onChange: (patch: SessionTuning) => void;
};

/** "medium" → "Medium", "minimal" → "Off": what the Thinking chip says. */
const thinkingWord = (effort: ReasoningEffort | null) =>
  effort == null ? "Auto" : effort === "minimal" ? "Off" : effortWord(effort);

const modeWord = (mode: "normal" | "brainstorm") =>
  mode === "brainstorm" ? "Brainstorm" : "Normal";

/*
 * Memoised, as `AnswerTurn` is and for the same reason: the route redraws on
 * every streamed token, and four Radix menus with their tooltips redrawn per
 * token is work that changes nothing on screen. The route keeps every prop
 * stable — the session and agent objects come from the query cache, the model
 * list is memoised and `onChange` is a stable callback — so this redraws when
 * a value it shows changes, or when a reply starts or stops.
 */
export const TurnDial = memo(function TurnDial({
  session,
  agent,
  models,
  prices,
  modelSpecs,
  canTune,
  busy,
  compact,
  onChange,
}: TurnDialProps) {
  const model = session.model ?? agent.model;
  const effort = session.reasoningEffort ?? agent.reasoningEffort;
  const web = session.webSearch ?? agent.webSearch;
  // A brainstorm-kind conversation is one by construction — it has the board —
  // so its mode is not a setting and the chip below says so instead of asking.
  const fixedBrainstorm = session.kind === "brainstorm";
  const mode = fixedBrainstorm ? "brainstorm" : (session.mode ?? agent.mode);
  // Absent, not disabled, on a model that does not reason: a control that can
  // never do anything is noise. Whatever is stored stays stored — the worker
  // ignores it there, and it is back in force the moment the model is.
  const reasons = specFor(modelSpecs, model).reasoning;

  // Hands back only what changed. A menu row for the value already in force is
  // a close, not a write — and a write would be a request that changes nothing
  // and a toast if it failed.
  const set = <K extends keyof SessionTuning>(key: K, next: SessionTuning[K]) => {
    if ((session[key] ?? null) === (next ?? null)) return;
    onChange({ [key]: next } as SessionTuning);
  };

  // The three tiers first, by their words, then every other id under "All
  // models" — the same shape as the picker on the agent's settings page, so
  // the chip and the page call one model one thing.
  const tiers = modelTiers(models);
  const tiered = new Set<string>(tiers.map((t) => t.model));
  const rest = models.filter((m) => !tiered.has(m));

  const live = canTune && !busy;
  const why = !canTune
    ? "Only the person who started this conversation can change this"
    : busy
      ? "Waiting for the current reply to finish"
      : null;

  return (
    // Scrolls sideways rather than wrapping. On a phone four chips and the
    // send button do not fit one line, and a chip wrapped under the send
    // button reads as belonging to it. `min-w-0` is what lets this shrink
    // inside the actions row at all.
    <div
      role="group"
      aria-label="How this conversation is answered"
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      <Dial
        label={`Model: ${modelLabel(model)}`}
        tip={why ?? "The model for this conversation"}
        live={live}
        readOnly={!canTune}
        chip={
          <DialChip>
            {modelLabel(model)}
            {canTune && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          </DialChip>
        }
      >
        {tiers.map((t) => {
          const agents = t.model === agent.model;
          return (
            <DropdownMenuCheckboxItem
              key={t.model}
              checked={t.model === model}
              // Picking the agent's own model stores null rather than its id,
              // so the conversation goes on following the agent if the agent
              // is moved later — which is what "the agent's" means.
              onSelect={() => set("model", agents ? null : t.model)}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span>
                    {t.label}
                    {agents && <span className="ml-1.5 text-muted-foreground">(agent's)</span>}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    {t.model} · {t.description}
                  </span>
                </span>
                <ModelCost price={priceFor(prices, t.model)} />
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {tiers.length > 0 && rest.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">
              All models
            </DropdownMenuLabel>
          </>
        )}
        {rest.map((m) => {
          const agents = m === agent.model;
          return (
            <DropdownMenuCheckboxItem
              key={m}
              checked={m === model}
              onSelect={() => set("model", agents ? null : m)}
            >
              <span className="flex w-full items-center justify-between">
                <span>
                  {m}
                  {agents && <span className="ml-1.5 text-muted-foreground">(agent's)</span>}
                </span>
                <ModelCost price={priceFor(prices, m)} />
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </Dial>

      {reasons && (
        <Dial
          label={`Thinking: ${thinkingWord(effort)}`}
          tip={why ?? "How long the model thinks before it answers"}
          live={live}
          readOnly={!canTune}
          chip={
            <DialWords icon={<Brain className="h-3.5 w-3.5" />} name="Thinking" compact={compact}>
              {thinkingWord(effort)}
            </DialWords>
          }
        >
          <Auto
            checked={session.reasoningEffort == null}
            agents={
              agent.reasoningEffort == null ? "model default" : thinkingWord(agent.reasoningEffort)
            }
            onSelect={() => set("reasoningEffort", null)}
          />
          <Choice
            checked={session.reasoningEffort === "minimal"}
            onSelect={() => set("reasoningEffort", "minimal")}
          >
            Off
          </Choice>
          {/* One column, one menu. Off and the three levels are four values of
              the same setting, so they sit in one list — but the levels are
              set under an "On" heading, so the list reads as the two
              decisions it is: think or not, then how hard. */}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            On
          </DropdownMenuLabel>
          {DIAL_EFFORTS.map((level) => (
            <Choice
              key={level}
              checked={session.reasoningEffort === level}
              hint={DIAL_EFFORT_HINTS[level]}
              onSelect={() => set("reasoningEffort", level)}
            >
              {effortWord(level)}
            </Choice>
          ))}
        </Dial>
      )}

      {fixedBrainstorm ? (
        // Said, not offered: there is no other mode for a conversation with an
        // idea board, so a menu here would be one row long.
        <DialChip>
          <Lightbulb className="h-3.5 w-3.5" aria-hidden />
          Brainstorm
        </DialChip>
      ) : (
        <Dial
          label={`Mode: ${modeWord(mode)}`}
          tip={why ?? "How freely the agent answers"}
          live={live}
          readOnly={!canTune}
          chip={
            <DialWords icon={<Lightbulb className="h-3.5 w-3.5" />} name="Mode" compact={compact}>
              {modeWord(mode)}
            </DialWords>
          }
        >
          <Auto
            checked={session.mode == null}
            agents={modeWord(agent.mode)}
            onSelect={() => set("mode", null)}
          />
          <Choice checked={session.mode === "normal"} onSelect={() => set("mode", "normal")}>
            Normal
          </Choice>
          <Choice
            checked={session.mode === "brainstorm"}
            hint="More varied answers, for thinking out loud."
            onSelect={() => set("mode", "brainstorm")}
          >
            Brainstorm
          </Choice>
        </Dial>
      )}

      <Dial
        label={`Web search: ${web ? "On" : "Off"}`}
        tip={why ?? "Whether the agent may search the web"}
        live={live}
        readOnly={!canTune}
        chip={
          <DialWords icon={<Globe className="h-3.5 w-3.5" />} name="Web" compact={compact}>
            {web ? "On" : "Off"}
          </DialWords>
        }
      >
        <Auto
          checked={session.webSearch == null}
          agents={agent.webSearch ? "On" : "Off"}
          onSelect={() => set("webSearch", null)}
        />
        <Choice checked={session.webSearch === true} onSelect={() => set("webSearch", true)}>
          On
        </Choice>
        <Choice checked={session.webSearch === false} onSelect={() => set("webSearch", false)}>
          Off
        </Choice>
      </Dial>
    </div>
  );
});

/**
 * One chip and its menu.
 *
 * The menu's `open` is held here so that a reply starting mid-choice closes it
 * and a press while one is running does not open it — without swapping the
 * trigger out from under the keyboard focus, which unmounting the menu would.
 *
 * Unavailable is `aria-disabled`, never `disabled`. A disabled button receives
 * no pointer events, so the tooltip saying WHY it will not open could never
 * appear — EDIT 7 in `prompt-input.tsx` is the same lesson on the send button.
 * For somebody who does not own the conversation the menu is not mounted at
 * all: the chip is a reading of the conversation, not a control they lack.
 */
function Dial({
  label,
  tip,
  live,
  readOnly,
  chip,
  children,
}: {
  label: string;
  tip: string;
  live: boolean;
  readOnly: boolean;
  chip: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!live || undefined}
      className={cn(
        "group shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        live ? "cursor-pointer" : "cursor-default",
        // Dimmed only while a reply runs, when it will come back. Somebody
        // reading a conversation they do not own is reading these values,
        // and they should be as legible as anything else on the row.
        !live && !readOnly && "opacity-60",
      )}
    >
      {chip}
    </button>
  );
  if (readOnly) return <PromptInputAction tooltip={tip}>{button}</PromptInputAction>;
  return (
    <PromptInputAction tooltip={tip}>
      <DropdownMenu open={open && live} onOpenChange={(next) => setOpen(next && live)}>
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="max-w-[20rem]">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </PromptInputAction>
  );
}

/**
 * One setting on the row, as words rather than as a chip.
 *
 * These were chips — grey wells, the model's in monospace — and three wells
 * in a row under the message read as three badges on it, which is a lot of
 * furniture for what are, most of the time, the defaults. Words in the
 * secondary ink, 14px, lifting to a soft fill when hovered: the same weight
 * as the hint line under the composer, which is the register these belong
 * in. A model id is a name here, not code, so it is set in the one face.
 */
function DialChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-meta font-medium text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground group-aria-disabled:group-hover:bg-transparent group-aria-disabled:group-hover:text-muted-foreground">
      {children}
    </span>
  );
}

/** A setting's insides: a mark, a word on a wide screen, the value. */
function DialWords({
  icon,
  name,
  compact,
  children,
}: {
  icon: ReactNode;
  name: string;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <DialChip>
      <span aria-hidden className="inline-flex">
        {icon}
      </span>
      {!compact && <span className="font-normal">{name}</span>}
      <span>{children}</span>
    </DialChip>
  );
}

/**
 * One row of a menu.
 *
 * Checkbox items with a tick rather than Radix radio items, although these are
 * radio choices: the wrapper's radio indicator is a filled circle, and a
 * circle as a selection mark is exactly what DESIGN.md's third idea rules out.
 * `menuitemcheckbox` still carries `aria-checked`, so a screen reader hears
 * which one is in force.
 */
function Choice({
  checked,
  hint,
  onSelect,
  children,
}: {
  checked: boolean;
  hint?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem checked={checked} onSelect={onSelect}>
      <span className="flex flex-col">
        <span>{children}</span>
        {hint && <span className="text-meta text-muted-foreground">{hint}</span>}
      </span>
    </DropdownMenuCheckboxItem>
  );
}

/** The first row of every menu: back to whatever the agent is set to, named. */
function Auto({
  checked,
  agents,
  onSelect,
}: {
  checked: boolean;
  agents: string;
  onSelect: () => void;
}) {
  return (
    <Choice checked={checked} onSelect={onSelect}>
      Auto <span className="text-muted-foreground">(agent's: {agents})</span>
    </Choice>
  );
}
