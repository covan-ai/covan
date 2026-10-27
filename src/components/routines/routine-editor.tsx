import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { lookup, msg, Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { AgentMark } from "@/components/agent-mark";
import { Chip } from "@/components/chip";
import { EventPicker } from "@/components/routines/event-picker";
import { SchedulePicker, scheduleError } from "@/components/routines/schedule-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useConnectComposio,
  useConnections,
  useFinishPendingComposioGrant,
  useToolConnections,
} from "@/hooks/use-connections";
import { NeedsBlock, type NeedsGroup } from "@/components/routines/needs-block";
import { canEditAgent } from "@/lib/agent-access";
import { flushEvents, trackStep } from "@/lib/analytics";
import { forgetParkedDraft, parkDraft, readParkedDraft } from "@/lib/routine-draft-park";
import { isAdminRole } from "@/lib/roles";
import {
  useCreateRoutine,
  useDeliveryChannels,
  useEventCatalog,
  useUpdateRoutine,
} from "@/hooks/use-routines";
import {
  DIAL_EFFORTS,
  effortWord,
  modelLabel,
  modelTiers,
  modelsFor,
  specFor,
  type ReasoningEffort,
} from "@/lib/agent-meta";
import { useAgentsStore } from "@/lib/agents-store";
import { api, ApiError } from "@/lib/api-client";
import { eventChoiceReady } from "@/lib/event-choice";
import { connectionGroupName, findUseCase, stepIdFor, templateById } from "@/lib/use-cases";
import type {
  CreatableSourceKind,
  EventChoice,
  Routine,
  RoutineSourceKind,
} from "@/lib/routines-api";
import { browserTimeZone } from "@/lib/timezones";
import { cn } from "@/lib/utils";

type Runs = "schedule" | "event" | "webhook" | "connection";

const AGENT_DEFAULT = "__agent";
const AUTO = "__auto";

/** A field of the editor (A28): a 160px label, the control, a hairline. */
function Row({
  label,
  htmlFor,
  children,
  last = false,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid items-start gap-2 py-4 md:grid-cols-[160px_minmax(0,1fr)] md:gap-5",
        !last && "border-b border-hairline",
      )}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="pt-1.5 text-sm font-medium">
          {label}
        </label>
      ) : (
        <div className="pt-1.5 text-sm font-medium">{label}</div>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** What the bar says is still missing, as keys (`msg`). */
const NEEDS = {
  name: msg("a name"),
  agent: msg("an agent"),
  instructions: msg("instructions"),
  delivery: msg("somewhere to deliver"),
  schedule: msg("a schedule"),
  event: msg("an event"),
  connection: msg("a connected source"),
};

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-meta leading-[1.45] text-muted-foreground">{children}</p>;
}

/** Where a routine starts from, as the editor's Runs field says it. */
function runsOf(routine: Routine): { runs: Runs; alsoSchedule: boolean } {
  if (routine.sourceKind === "connection") return { runs: "connection", alsoSchedule: false };
  if (routine.triggerKind === "event") return { runs: "event", alsoSchedule: false };
  if (routine.triggerKind === "webhook" || routine.triggerKind === "both") {
    return { runs: "webhook", alsoSchedule: routine.triggerKind === "both" };
  }
  return { runs: "schedule", alsoSchedule: false };
}

/**
 * A routine, made or changed in one place (A28): Name, Agent, Runs, Schedule,
 * Instructions, Delivers to, Model and what a run is likely to cost — with
 * Cancel, Run a test and Save routine in the bar.
 *
 * It replaces the two dialogs. What can only be chosen once — the agent,
 * and where it starts from — is shown, not offered, on a routine that
 * exists: the API does not move a routine between agents or sources.
 */
export function RoutineEditor({
  routine,
  initialAgentId,
  templateId,
  focusSentence = false,
  cancelTo,
  onSaved,
}: {
  /** The routine being changed; absent for a new one. */
  routine?: Routine;
  /** A new routine's agent, from `?agent=`. */
  initialAgentId?: string;
  /** A template to start from, from `?template=`. */
  templateId?: string;
  /** Put the cursor in "Start from a sentence", from `?focus=sentence`. */
  focusSentence?: boolean;
  /** Where Cancel goes. */
  cancelTo: string;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { agents, bundles } = useAgentsStore();
  const { data: channels = [] } = useDeliveryChannels();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: connectionData } = useConnections();
  const createRoutine = useCreateRoutine();
  const updateRoutine = useUpdateRoutine();
  const template = routine || !templateId ? undefined : templateById(templateId);
  // The use case behind the template, for what it needs before its first run
  // (B3). Only on a new routine started from one.
  const found = template && templateId ? findUseCase(templateId) : undefined;
  const useCase = found?.kind === "routine" ? found : undefined;
  const needs = useCase?.needs;
  const { data: toolData } = useToolConnections();
  const connectApp = useConnectComposio();
  // A connect started from here comes back here, and is finished here.
  useFinishPendingComposioGrant();
  // A form parked before that round trip (`routine-draft-park.ts`): read in the
  // initialisers below, and forgotten once the page has it.
  const [parked] = useState(() =>
    !routine && templateId ? readParkedDraft("/routines/new", templateId) : null,
  );
  useEffect(() => {
    if (parked) forgetParkedDraft();
  }, [parked]);

  const emailChannels = channels.filter((c) => c.kind === "email");
  const slackChannels = channels.filter((c) => c.kind !== "email");
  const usableConnections = (connectionData?.connections ?? []).filter((c) => !c.needsFolder);

  // ---- the form ---------------------------------------------------------
  const start = routine ? runsOf(routine) : { runs: "schedule" as Runs, alsoSchedule: false };
  const [sourceKind] = useState<RoutineSourceKind | CreatableSourceKind>(
    routine?.sourceKind ?? template?.draft.sourceKind ?? "none",
  );
  const [name, setName] = useState(
    routine?.name ?? parked?.name ?? (template ? lookup(t, template.draft.name) : ""),
  );
  // Derived until picked: the agents may arrive a beat after the page.
  const [pickedAgent, setAgentId] = useState(
    routine?.agentId ?? parked?.agentId ?? initialAgentId ?? "",
  );
  const agentId = pickedAgent || agents[0]?.id || "";
  const [runs, setRuns] = useState<Runs>(
    (parked?.runs as Runs | undefined) ??
      (useCase?.routine.triggerKind === "event"
        ? "event"
        : needs?.source
          ? "connection"
          : start.runs),
  );
  const [alsoSchedule, setAlsoSchedule] = useState(start.alsoSchedule);
  const [eventChoice, setEventChoice] = useState<EventChoice | null>(
    useCase?.routine.event ?? null,
  );
  const [pickedConnection, setConnectionId] = useState(
    routine?.connectionId ?? parked?.connectionId ?? "",
  );
  // A use case that starts from a synced source starts from the first one of
  // that kind, until somebody picks another.
  const sourceProvider =
    needs?.source === "drive" ? "google_drive" : needs?.source === "notion" ? "notion" : null;
  const connectionId =
    pickedConnection ||
    (sourceProvider
      ? (usableConnections.find((c) => c.provider === sourceProvider)?.id ?? "")
      : "");
  const [cron, setCron] = useState(
    routine?.scheduleCron ?? parked?.cron ?? template?.draft.scheduleCron ?? "0 9 * * 1",
  );
  const [timezone, setTimezone] = useState(
    routine?.timezone ?? parked?.timezone ?? me?.workspace.timezone ?? browserTimeZone() ?? "UTC",
  );
  const [instruction, setInstruction] = useState(
    routine?.instruction ?? parked?.instruction ?? template?.draft.instruction ?? "",
  );
  const [fileTo, setFileTo] = useState<string | null>(
    routine?.outputBundleId ?? parked?.fileTo ?? null,
  );
  const [emailIds, setEmailIds] = useState<string[] | null>(parked?.emailIds ?? null);
  const [slackId, setSlackId] = useState<string | null | undefined>(parked?.slackId);
  const [newEmail, setNewEmail] = useState("");
  const [inbox, setInbox] = useState(routine?.deliverInbox ?? parked?.inbox ?? true);
  const [model, setModel] = useState<string | null>(routine?.model ?? parked?.model ?? null);
  const [effort, setEffort] = useState<ReasoningEffort | null>(
    routine?.reasoningEffort ?? (parked?.effort as ReasoningEffort | null | undefined) ?? null,
  );
  // The Needs block's own switches: "don't ask again" is on unless turned off
  // for a connection, and the browser is on unless turned off.
  const [allowOff, setAllowOff] = useState<string[]>(parked?.allowOff ?? []);
  const [browserOn, setBrowserOn] = useState(parked?.browserOn ?? true);
  const [prose, setProse] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const touch = () => setDirty(true);

  // Where it delivers, until somebody changes it: the routine's own channels,
  // or for a new one the first channel of the kind a template asked for.
  const wanted = template?.draft.channelKind ?? "email";
  const startIds = routine
    ? [routine.deliveryChannelId, ...routine.channelIds]
    : wanted === "slack" && slackChannels[0]
      ? [slackChannels[0].id]
      : emailChannels[0]
        ? [emailChannels[0].id]
        : [];
  const emails = emailIds ?? startIds.filter((id) => emailChannels.some((c) => c.id === id));
  const slack =
    slackId !== undefined
      ? slackId
      : (startIds.find((id) => slackChannels.some((c) => c.id === id)) ?? null);

  const agent = agents.find((a) => a.id === agentId);

  // ---- what a use case needs (B3) ----------------------------------------
  const isAdmin = me ? isAdminRole(me.members?.find((m) => m.id === me.user.id)?.role) : false;
  const activeApps = (toolData?.connections ?? []).filter(
    (c) => c.transport === "composio" && c.status === "active",
  );
  /**
   * The connection a "don't ask again" would be written for in a group: the
   * person's own first, then — for an admin — a shared one. The same rule as
   * 0140's insert policy, asked only to decide what to offer.
   */
  const pickConnection = (group: string[]) => {
    if (!agent || !canEditAgent(agent)) return null;
    const inGroup = activeApps.filter((c) => group.includes(c.toolkitSlug ?? ""));
    return (
      inGroup.find((c) => c.mine) ??
      (isAdmin ? inGroup.find((c) => c.scope === "workspace") : undefined) ??
      null
    );
  };
  const needsGroups: NeedsGroup[] = (needs?.connections ?? []).map((group) => {
    const connected = activeApps.some((c) => group.includes(c.toolkitSlug ?? ""));
    const changes = (needs?.changes ?? []).some((toolkit) => group.includes(toolkit));
    const grant = changes ? pickConnection(group) : null;
    return {
      key: group.join("|"),
      name: connectionGroupName(group, t),
      toolkits: group,
      connected,
      ...(changes
        ? {
            change: {
              connectionId: grant?.id ?? null,
              on: grant ? !allowOff.includes(grant.id) : false,
            },
          }
        : {}),
    };
  });
  const showsNeeds =
    !routine &&
    !!needs &&
    (needsGroups.length > 0 || !!needs.source || !!needs.browser || !!needs.webSearch);
  const readsFolders = bundles.filter((b) => agent?.bundleIds.includes(b.id)).map((b) => b.name);
  const isEvent = runs === "event";
  const needsSchedule = runs === "schedule" || runs === "connection" || alsoSchedule;
  const { data: eventCatalog = [] } = useEventCatalog(isEvent);

  // ---- the model --------------------------------------------------------
  const served = modelsFor(me?.models, agent?.model ?? "");
  const tiers = modelTiers(served);
  const runModel = model ?? agent?.model ?? "";
  const reasons = specFor(me?.modelSpecs, runModel).reasoning;

  // ---- the estimate -----------------------------------------------------
  const { data: estimate } = useQuery({
    queryKey: ["routines", "estimate", agentId, routine?.id, model, cron, timezone],
    queryFn: () =>
      api.routines.estimate({
        agentId,
        routineId: routine?.id,
        model: model ?? undefined,
        cron: needsSchedule ? cron : undefined,
        timezone,
      }),
    enabled: agentId !== "" && (!needsSchedule || scheduleError(cron) === null),
    staleTime: 60_000,
  });

  const primary = emails[0] ?? slack ?? null;
  const others = [...emails.slice(1), ...(slack && slack !== primary ? [slack] : [])];
  // With no channel yet, an address is typed — your own unless you say
  // otherwise, which is confirmed as it is added.
  const newAddress = newEmail.trim() || me?.user.email || "";
  const canDeliver = primary !== null || (channels.length === 0 && newAddress !== "");

  // Computed every render: cheap, and the inputs include a value derived from
  // the connections list, which a manual memo could not track.
  const problems = (() => {
    const list: string[] = [];
    if (!name.trim()) list.push(NEEDS.name);
    if (!agentId) list.push(NEEDS.agent);
    if (!instruction.trim()) list.push(NEEDS.instructions);
    if (!canDeliver) list.push(NEEDS.delivery);
    if (needsSchedule && (cron.trim() === "" || scheduleError(cron) !== null)) {
      list.push(NEEDS.schedule);
    }
    if (isEvent && !routine && !eventChoiceReady(eventCatalog, eventChoice)) {
      list.push(NEEDS.event);
    }
    if (runs === "connection" && !routine && !connectionId) list.push(NEEDS.connection);
    return list;
  })();

  const saving = createRoutine.isPending || updateRoutine.isPending;

  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api.routines.draft(prose.trim(), timezone);
      setName(d.name);
      setInstruction(d.instruction);
      setCron(d.cron);
      setTimezone(d.timezone);
      setRuns("schedule");
      touch();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 503
          ? t("{{message}} Fill it in below instead.", { message: err.message })
          : t("Couldn't read that one — fill it in below instead."),
      );
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    if (problems.length > 0 || saving) return;
    try {
      if (routine) {
        await updateRoutine.mutateAsync({
          id: routine.id,
          patch: {
            name: name.trim(),
            instruction: instruction.trim(),
            ...(needsSchedule ? { scheduleCron: cron.trim(), timezone } : {}),
            ...(primary ? { deliveryChannelId: primary } : {}),
            ...(routine.sourceKind !== "workspace" ? { outputBundleId: fileTo } : {}),
            deliverInbox: inbox,
            model,
            reasoningEffort: effort,
          },
        });
        await api.routines.setChannels(routine.id, others);
        setDirty(false);
        toast.success(t("Routine saved"));
        onSaved(routine.id);
        return;
      }
      const created = await createRoutine.mutateAsync({
        agentId,
        name: name.trim(),
        sourceKind: runs === "connection" ? "connection" : (sourceKind as CreatableSourceKind),
        triggerKind:
          runs === "event"
            ? "event"
            : runs === "webhook"
              ? alsoSchedule
                ? "both"
                : "webhook"
              : "schedule",
        ...(isEvent && eventChoice ? { event: eventChoice } : {}),
        connectionId: runs === "connection" ? connectionId : null,
        instruction: instruction.trim(),
        ...(primary ? { deliveryChannelId: primary } : { deliveryEmail: newAddress }),
        scheduleCron: cron.trim(),
        timezone,
        outputBundleId: sourceKind === "workspace" ? null : fileTo,
        endsAfterRuns: template?.endsAfterRuns ?? null,
        deliverInbox: inbox,
        model,
        reasoningEffort: effort,
      });
      if (others.length > 0) await api.routines.setChannels(created.id, others);
      // What the use case's Needs block said yes to, written after the routine
      // exists. Each is its own request, and none of them undoes the routine:
      // a permission that did not save is said, and set on Integrations.
      const missed: string[] = [];
      for (const g of needsGroups) {
        if (!g.connected || !g.change?.connectionId || !g.change.on) continue;
        try {
          await api.toolConnections.setGrant({ agentId, connectionId: g.change.connectionId });
        } catch {
          missed.push(g.name);
        }
      }
      if (needs?.browser && browserOn) {
        try {
          await api.routines.update(created.id, { browserAccess: "all" });
        } catch {
          missed.push(t("the browser"));
        }
      }
      if (missed.length > 0) {
        toast.error(
          t("Routine saved, but could not allow {{things}}. Set it on Integrations.", {
            things: missed.join(", "),
          }),
        );
      }
      if (useCase) {
        trackStep(stepIdFor(useCase.id), "completed");
        void flushEvents();
      }
      toast.success(
        created.confirmation
          ? t(
              "Routine saved. We've emailed that address a link — nothing is sent there until it's confirmed.",
            )
          : t("Routine saved"),
      );
      onSaved(created.id);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t("Could not save that routine");
      toast.error(
        message.includes("unusable schedule")
          ? t("That schedule can't be read. Try 0 9 * * * for every day at 09:00.")
          : message === "not an email address"
            ? t("That doesn't look like an email address.")
            : message,
      );
    }
  };

  const test = async () => {
    if (!routine || testing) return;
    setTesting(true);
    try {
      const result = await api.routines.test(routine.id);
      if (result.status === "failed")
        toast.error(t("The test run failed — see its thread for why"));
      else toast.success(t("The test ran — its thread is in your Inbox"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Could not run a test"));
    } finally {
      setTesting(false);
    }
  };

  const money = (n: number) =>
    estimate?.unit === "usd"
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          currencyDisplay: "narrowSymbol",
        }).format(n)
      : n.toLocaleString(locale);
  const agentName = agent?.name;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 lg:px-6">
        <h2 className="m-0 min-w-0 truncate text-lead font-semibold">
          {routine ? routine.name : t("New routine")}
        </h2>
        <span className="text-meta text-muted-foreground">
          {!routine || dirty ? t("Unsaved") : t("Saved")}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button asChild variant="secondary">
            <Link to={cancelTo}>{t("Cancel")}</Link>
          </Button>
          {routine && (
            <Button variant="secondary" onClick={() => void test()} disabled={testing || dirty}>
              {testing ? t("Testing…") : t("Run a test")}
            </Button>
          )}
          <Button onClick={() => void save()} disabled={problems.length > 0 || saving}>
            {saving ? t("Saving…") : t("Save routine")}
          </Button>
        </div>
      </div>

      <div className="px-4 pt-2 pb-12 lg:px-8">
        <div className="max-w-[760px]">
          {!routine && (
            <Row label={t("Start from a sentence")} htmlFor="routine-prose">
              <div className="flex max-w-[560px] gap-2">
                <Input
                  id="routine-prose"
                  // Only when the address asks: the link that sends it is
                  // "Describe it in a sentence", whose whole point is this box.
                  autoFocus={focusSentence}
                  value={prose}
                  placeholder={t("Every Monday at 9, summarise last week's tickets for the team.")}
                  onChange={(e) => setProse(e.target.value)}
                />
                <Button
                  variant="secondary"
                  onClick={() => void draft()}
                  disabled={!prose.trim() || drafting}
                >
                  {drafting ? t("Reading…") : t("Fill in")}
                </Button>
              </div>
              <Hint>
                {t("Optional. It fills in the fields below; you check them before saving.")}
              </Hint>
            </Row>
          )}

          <Row label={t("Name")} htmlFor="routine-name">
            <Input
              id="routine-name"
              className="max-w-[420px]"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                touch();
              }}
            />
          </Row>

          <Row label={t("Agent")}>
            <Select
              value={agentId}
              disabled={!!routine}
              onValueChange={(v) => {
                setAgentId(v);
                touch();
              }}
            >
              <SelectTrigger aria-label={t("Agent")} className="max-w-[420px]">
                <SelectValue placeholder={t("Pick an agent")} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="inline-flex items-center gap-2">
                      <AgentMark agent={a} size={20} />
                      {a.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agent && (
              <Hint>
                {t("Runs with the agent’s model, tools and knowledge.")}{" "}
                {readsFolders.length > 0
                  ? t("{{agent}} reads {{folders}}.", {
                      agent: agent.name,
                      folders: readsFolders.join(", "),
                    })
                  : t("{{agent}} reads no folders yet.", { agent: agent.name })}
              </Hint>
            )}
          </Row>

          {sourceKind !== "workspace" && (
            <Row label={t("Runs")}>
              <Select
                value={runs}
                disabled={!!routine}
                onValueChange={(v) => {
                  setRuns(v as Runs);
                  touch();
                }}
              >
                <SelectTrigger aria-label={t("Runs")} className="max-w-[420px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="schedule">{t("On a schedule")}</SelectItem>
                  <SelectItem value="event">{t("When an app event happens")}</SelectItem>
                  <SelectItem value="webhook">{t("On a webhook")}</SelectItem>
                  {(usableConnections.length > 0 || runs === "connection") && (
                    <SelectItem value="connection">{t("From a connected source")}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {runs === "webhook" && (
                <>
                  <label className="mt-3 flex items-center gap-2.5 text-sm">
                    <Switch
                      checked={alsoSchedule}
                      disabled={!!routine}
                      onCheckedChange={(on) => {
                        setAlsoSchedule(on);
                        touch();
                      }}
                      aria-label={t("Also on its schedule")}
                    />
                    {t("Also on its schedule")}
                  </label>
                  <Hint>
                    {t(
                      "You get a URL to paste into whatever should start it once it is saved, and whatever it POSTs is what the agent reads.",
                    )}
                  </Hint>
                </>
              )}
              {isEvent &&
                (routine ? (
                  <Hint>{t("The event it listens for is set on the routine’s page.")}</Hint>
                ) : (
                  <div className="mt-3">
                    <EventPicker
                      catalog={eventCatalog}
                      value={eventChoice}
                      onChange={(c) => {
                        setEventChoice(c);
                        touch();
                      }}
                    />
                  </div>
                ))}
              {runs === "connection" && (
                <div className="mt-3">
                  <Select
                    value={connectionId}
                    disabled={!!routine}
                    onValueChange={(v) => {
                      setConnectionId(v);
                      touch();
                    }}
                  >
                    <SelectTrigger aria-label={t("Connected source")} className="max-w-[420px]">
                      <SelectValue placeholder={t("Pick a connection")} />
                    </SelectTrigger>
                    <SelectContent>
                      {usableConnections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.accountLabel}
                          {c.folderName ? ` · ${c.folderName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Hint>
                    {t(
                      "It reports what the connection has already synced, so it sees a change no sooner than the next sync does.",
                    )}
                  </Hint>
                </div>
              )}
            </Row>
          )}

          {needsSchedule && (
            <Row label={t("Schedule")}>
              <SchedulePicker
                value={cron}
                onChange={(c) => {
                  setCron(c);
                  touch();
                }}
                timezone={timezone}
                onTimezone={(tz) => {
                  setTimezone(tz);
                  touch();
                }}
              />
            </Row>
          )}

          {showsNeeds && needs ? (
            <Row label={t("Needs")}>
              <NeedsBlock
                groups={needsGroups}
                agentName={agent?.name ?? t("this agent")}
                connecting={connectApp.isPending}
                onConnect={(toolkit) => {
                  if (!templateId) return;
                  parkDraft("/routines/new", templateId, {
                    agentId,
                    name,
                    runs,
                    connectionId: pickedConnection,
                    cron,
                    timezone,
                    instruction,
                    fileTo,
                    emailIds,
                    slackId,
                    inbox,
                    model,
                    effort,
                    allowOff,
                    browserOn,
                  });
                  connectApp.mutate(
                    {
                      toolkit,
                      returnTo: `/routines/new?template=${encodeURIComponent(templateId)}&agent=${encodeURIComponent(agentId)}`,
                    },
                    {
                      onError: (e) => {
                        forgetParkedDraft();
                        toast.error(e instanceof Error ? e.message : String(e));
                      },
                    },
                  );
                }}
                onAllow={(id, on) => {
                  setAllowOff((list) => (on ? list.filter((x) => x !== id) : [...list, id]));
                  touch();
                }}
                source={
                  needs.source
                    ? {
                        name: needs.source === "drive" ? "Google Drive" : "Notion",
                        connected: usableConnections.some((c) => c.provider === sourceProvider),
                      }
                    : undefined
                }
                browser={
                  needs.browser
                    ? {
                        on: browserOn,
                        onChange: (on) => {
                          setBrowserOn(on);
                          touch();
                        },
                      }
                    : undefined
                }
                webSearch={
                  needs.webSearch && agent
                    ? { on: agent.webSearch === true, agentId: agent.id }
                    : undefined
                }
              />
            </Row>
          ) : null}

          <Row label={t("Instructions")} htmlFor="routine-instruction">
            <Textarea
              id="routine-instruction"
              className="min-h-[110px]"
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                touch();
              }}
            />
            <Hint>
              {t(
                "Write it as you would to a colleague. The agent reads this and nothing else at the start of each run.",
              )}
            </Hint>
          </Row>

          <Row label={t("Delivers to")}>
            <div className="flex flex-col gap-2.5">
              {sourceKind !== "workspace" && (
                <DeliveryRow
                  label={t("Knowledge")}
                  on={fileTo !== null}
                  onToggle={(on) => {
                    setFileTo(on ? (bundles[0]?.id ?? null) : null);
                    touch();
                  }}
                  disabled={bundles.length === 0}
                >
                  <Select
                    value={fileTo ?? ""}
                    disabled={fileTo === null}
                    onValueChange={(v) => {
                      setFileTo(v);
                      touch();
                    }}
                  >
                    <SelectTrigger aria-label={t("Folder to file it in")}>
                      <SelectValue placeholder={t("Pick a folder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {bundles.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DeliveryRow>
              )}

              <DeliveryRow
                label={t("Email")}
                on={emails.length > 0 || (channels.length === 0 && newAddress !== "")}
                onToggle={(on) => {
                  setEmailIds(on && emailChannels[0] ? [emailChannels[0].id] : []);
                  touch();
                }}
                disabled={emailChannels.length === 0}
              >
                {channels.length === 0 && !routine ? (
                  <Input
                    type="email"
                    aria-label={t("Email address")}
                    placeholder={me?.user.email ?? t("you@company.com")}
                    value={newEmail}
                    onChange={(e) => {
                      setNewEmail(e.target.value);
                      touch();
                    }}
                  />
                ) : (
                  <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1">
                    {emails.map((id) => {
                      const address = emailChannels.find((c) => c.id === id)?.label;
                      return (
                        <Chip key={id} className="pr-1">
                          {address ?? t("An address")}
                          <button
                            type="button"
                            aria-label={
                              address
                                ? t("Stop sending to {{address}}", { address })
                                : t("Stop sending to this address")
                            }
                            onClick={() => {
                              setEmailIds(emails.filter((x) => x !== id));
                              touch();
                            }}
                            className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3" />
                          </button>
                        </Chip>
                      );
                    })}
                    <DropdownMenu>
                      <DropdownMenuTrigger className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-meta text-muted-foreground hover:text-foreground">
                        <Plus className="size-3.5" /> {t("Add…")}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-64">
                        {emailChannels
                          .filter((c) => !emails.includes(c.id))
                          .map((c) => (
                            <DropdownMenuItem
                              key={c.id}
                              onSelect={() => {
                                setEmailIds([...emails, c.id]);
                                touch();
                              }}
                            >
                              {c.label}
                              {!c.confirmed && (
                                <span className="ml-auto text-xs text-muted-foreground">
                                  {t("not confirmed")}
                                </span>
                              )}
                            </DropdownMenuItem>
                          ))}
                        {emailChannels.length > emails.length && <DropdownMenuSeparator />}
                        <DropdownMenuItem asChild>
                          <Link to="/settings/preferences">{t("Add an address in Settings…")}</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </DeliveryRow>

              <DeliveryRow
                label={t("Slack")}
                on={slack !== null}
                onToggle={(on) => {
                  setSlackId(on ? (slackChannels[0]?.id ?? null) : null);
                  touch();
                }}
                disabled={slackChannels.length === 0}
              >
                {slackChannels.length === 0 ? (
                  <span className="text-meta text-muted-foreground">
                    <Trans
                      t={t}
                      i18nKey="Add a Slack channel in <a>Settings</a>."
                      components={{
                        a: (
                          <Link
                            to="/settings/preferences"
                            className="underline underline-offset-2"
                          />
                        ),
                      }}
                    />
                  </span>
                ) : (
                  <Select
                    value={slack ?? ""}
                    disabled={slack === null}
                    onValueChange={(v) => {
                      setSlackId(v);
                      touch();
                    }}
                  >
                    <SelectTrigger aria-label={t("Slack channel")}>
                      <SelectValue placeholder={t("Pick a channel")} />
                    </SelectTrigger>
                    <SelectContent>
                      {slackChannels.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </DeliveryRow>

              <DeliveryRow
                label={t("Inbox")}
                wide
                on={inbox}
                onToggle={(on) => {
                  setInbox(on);
                  touch();
                }}
              >
                <span className="text-meta text-muted-foreground">
                  {agentName
                    ? t("Everyone who can use {{agent}} sees the result as a message.", {
                        agent: agentName,
                      })
                    : t("Everyone who can use the agent sees the result as a message.")}
                </span>
              </DeliveryRow>
            </div>
          </Row>

          <Row label={t("Model")}>
            <div className="flex flex-wrap gap-2">
              <Select
                value={model ?? AGENT_DEFAULT}
                onValueChange={(v) => {
                  setModel(v === AGENT_DEFAULT ? null : v);
                  touch();
                }}
              >
                <SelectTrigger aria-label={t("Model")} className="w-auto gap-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AGENT_DEFAULT}>
                    {t("Agent default · {{model}}", { model: modelLabel(agent?.model ?? "", t) })}
                  </SelectItem>
                  {tiers.map((tier) => (
                    <SelectItem key={tier.model} value={tier.model}>
                      {lookup(t, tier.label)}
                    </SelectItem>
                  ))}
                  {served
                    .filter((m) => !tiers.some((tier) => tier.model === m))
                    .map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {reasons && (
                <Select
                  value={effort ?? AUTO}
                  onValueChange={(v) => {
                    setEffort(v === AUTO ? null : (v as ReasoningEffort));
                    touch();
                  }}
                >
                  <SelectTrigger aria-label={t("Thinking")} className="w-auto gap-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>{t("Thinking · Auto")}</SelectItem>
                    <SelectItem value="minimal">{t("Thinking · Off")}</SelectItem>
                    {DIAL_EFFORTS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t("Thinking · {{level}}", { level: effortWord(level, t) })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </Row>

          {estimate && estimate.low !== null && estimate.high !== null && (
            <Row label={t("Estimate")} last>
              <div className="pt-1.5 text-sm font-medium">
                {estimate.unit === "usd"
                  ? t("About {{low}} to {{high}} per run", {
                      low: money(estimate.low),
                      high: money(estimate.high),
                    })
                  : t("About {{low}} to {{high}} credits per run", {
                      low: money(estimate.low),
                      high: money(estimate.high),
                    })}
                {estimate.runsPerMonth !== null
                  ? ` · ${t("{{count}} run a month", {
                      count: estimate.runsPerMonth,
                      defaultValue_other: "{{count}} runs a month",
                    })}`
                  : ""}
              </div>
              <Hint>
                {estimate.basedOn?.kind === "routine"
                  ? agentName
                    ? t("Based on {{routine}}, which {{agent}} already runs.", {
                        routine: estimate.basedOn.name,
                        agent: agentName,
                      })
                    : t("Based on {{routine}}, which this agent already runs.", {
                        routine: estimate.basedOn.name,
                      })
                  : estimate.basedOn?.kind === "replies"
                    ? agentName
                      ? t("Based on what {{agent}}'s replies cost.", { agent: agentName })
                      : t("Based on what this agent's replies cost.")
                    : null}{" "}
                {t("A test run costs the same and goes only to you.")}
              </Hint>
            </Row>
          )}

          {problems.length > 0 && dirty && (
            <p className="mt-4 text-meta text-muted-foreground">
              {t("Still needs {{things}}.", {
                things: problems.map((p) => lookup(t, p)).join(", "),
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One place a run goes (A28): a switch, its name, and which one. */
function DeliveryRow({
  label,
  on,
  onToggle,
  disabled = false,
  wide = false,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  disabled?: boolean;
  /** A sentence rather than a control: it may run past the 320px column. */
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5">
      <Switch
        checked={on}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={t("Deliver to {{place}}", { place: label })}
      />
      <span className="w-[110px] shrink-0 text-sm">{label}</span>
      <div className={cn("min-w-0 flex-1", !wide && "max-w-[320px]")}>{children}</div>
    </div>
  );
}
