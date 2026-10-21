import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import { useDeliveryChannels, useCreateRoutine, useEventCatalog } from "@/hooks/use-routines";
import { useConnections } from "@/hooks/use-connections";
import { SchedulePicker, scheduleError } from "@/components/routines/schedule-picker";
import { TemplatePicker } from "@/components/routines/template-picker";
import { EventPicker } from "@/components/routines/event-picker";
import { eventChoiceReady } from "@/lib/event-choice";
import type { CreatableSourceKind, EventChoice, RoutineTriggerKind } from "@/lib/routines-api";
import { templateById, type RoutineTemplate } from "@/lib/routine-templates";

/**
 * Says what a connection routine can and cannot see, in the units the person
 * setting the schedule is already thinking in.
 *
 * Written from the connection's own interval rather than as a fixed sentence
 * about "six hours", because the default is only a default and somebody who has
 * turned theirs down to fifteen minutes should not be told otherwise.
 */
function syncCaveat(intervalMinutes: number | undefined): string {
  if (intervalMinutes === undefined) {
    return "A routine reports what the connection has already synced, so it sees a change no sooner than the next sync does.";
  }
  const every =
    intervalMinutes % 60 === 0
      ? `${intervalMinutes / 60} ${intervalMinutes === 60 ? "hour" : "hours"}`
      : `${intervalMinutes} minutes`;
  return `This connection syncs every ${every}, and the routine reports what the sync has already imported — so running it more often than that will not find changes any sooner.`;
}

const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function CreateRoutineDialog({
  agentId,
  openTemplate,
  onTemplateConsumed,
}: {
  agentId: string;
  /** A template id from the URL. Opens the dialog on it. */
  openTemplate?: string;
  /** Called once the request has been acted on, so the URL can be cleaned. */
  onTemplateConsumed?: () => void;
}) {
  const { data: channels = [], isPending: channelsPending } = useDeliveryChannels();
  // The one xor the "Deliver to" field turns on, named once rather than
  // repeated as `channels.length === 0` at every site that branches on it.
  // A list that has not answered yet is not an empty one: reading `[]` as "no
  // channels" rendered the address box on a deep-linked open and then swapped
  // it for a pre-selected Select once the list arrived, discarding whatever
  // had been typed and leaving Create enabled for a channel nobody chose.
  const needsNewChannel = !channelsPending && channels.length === 0;
  const createRoutine = useCreateRoutine();
  // A connection that has never finished setting itself up has no documents to
  // report, so offering it here would create a routine that can only ever skip.
  // Paused ones are still offered: a pause is usually temporary and the routine
  // outlives it.
  const { data: connectionData } = useConnections();
  const connections = (connectionData?.connections ?? []).filter((c) => !c.needsFolder);

  // Facts the picker needs, read off state this screen already holds.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { agents } = useAgentsStore();
  const facts = {
    // This agent's documents, not the workspace's: the series reads what this
    // agent can see. See `TemplateFacts`.
    agentDocumentCount: agents.find((a) => a.id === agentId)?.documents.length ?? 0,
    isAdmin: me?.members.find((m) => m.id === me.user.id)?.role === "admin",
    gapReportEnabled: me?.workspace.gapReportEnabled ?? false,
    memberCount: me?.members.length ?? 1,
  };

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [prose, setProse] = useState("");
  const [drafting, setDrafting] = useState(false);

  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<CreatableSourceKind>("none");
  const [triggerKind, setTriggerKind] = useState<RoutineTriggerKind>("schedule");
  // What an event routine waits for. Only read when `triggerKind` is
  // `event`; kept across a switch away and back so a half-made choice is not
  // thrown away by a misclick.
  const [eventChoice, setEventChoice] = useState<EventChoice | null>(null);
  // Asked for only once somebody picks "when something happens", because the
  // catalogue reads which apps are connected and most routines never need it.
  const { data: eventCatalog = [] } = useEventCatalog(open && triggerKind === "event");
  // An event routine is never due, so its schedule is not asked for — the
  // engine still wants one on the row (0055), and gets the default.
  const isEvent = sourceKind === "none" && triggerKind === "event";
  const [connectionId, setConnectionId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState(browserTimezone());
  const [channelId, setChannelId] = useState("");
  // Flips the moment the person picks a channel by hand, for the same reason
  // `emailTouched` below exists: a template opened straight from a link
  // (`openTemplate`) renders step 2 on mount, often before `useDeliveryChannels`
  // has resolved, so `channels` is `[]` and whatever `applyTemplate` computed
  // from it is stale by the time the real list arrives. `channelId` alone
  // cannot tell "the person has not touched this" apart from "nothing resolved
  // yet", which is why `resolvedChannelId` below reads this flag rather than
  // `channelId === ""`.
  const [channelTouched, setChannelTouched] = useState(false);
  // The channel kind a template or a drafted routine asked for (`d.channelKind`
  // / `draft.channelKind`), kept rather than resolved once — the channel it
  // names may not exist in `channels` yet at the moment it is set. `null` for
  // "Set it up myself", which has no preference and takes whichever channel is
  // first, same as before this existed.
  const [wantedChannelKind, setWantedChannelKind] = useState<"email" | "slack" | null>(null);
  // Only relevant once `needsNewChannel` is true — see the "Deliver to" branch
  // below. Raw user input, empty until they type. What the field shows and
  // what `save()` sends is `resolvedDeliveryEmail` below, not this directly —
  // see its comment for why.
  const [deliveryEmail, setDeliveryEmail] = useState("");
  // Flips the moment the person edits the field by hand. Before that, the
  // field shows `me`'s address live rather than a value captured once: a
  // template opened straight from a link (`openTemplate`) renders step 2 on
  // mount, often before `me` has resolved, and nothing afterwards would have
  // re-seeded a value an effect or an entry handler had already written.
  const [emailTouched, setEmailTouched] = useState(false);
  // The address's own refusal, shown under the address. Kept apart from
  // `fieldError` because it is cleared by editing the field it belongs to.
  const [emailError, setEmailError] = useState<string | null>(null);
  const [endsAfterRuns, setEndsAfterRuns] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: "schedule";
    message: string;
  } | null>(null);

  // What the field shows and what `save()` sends — the same expression, so
  // the two can never disagree. Untouched, it tracks `me.user.email` on every
  // render; touched, it is exactly what the person typed, including empty,
  // so clearing it to write a different address is never put back.
  const resolvedDeliveryEmail = emailTouched
    ? deliveryEmail
    : deliveryEmail || me?.user.email || "";

  // The channel id a wanted kind resolves to against the LIVE list, or the
  // first channel if there is no wanted kind (or no match for it) — the same
  // fallback `skipToForm` and the unknown-template branch below compute by
  // hand. Kept as a function rather than inlined so `applyTemplate`, `runDraft`
  // and `resolvedChannelId` all do the lookup the same way.
  const channelFor = (kind: "email" | "slack" | null) => {
    if (kind) {
      const wantedKind = kind === "slack" ? "slack_webhook" : "email";
      const match = channels.find((c) => c.kind === wantedKind);
      if (match) return match.id;
    }
    return channels[0]?.id ?? "";
  };

  // What the Select shows and what `save()` sends — the same shape as
  // `resolvedDeliveryEmail` above and for the same reason: untouched, it
  // re-resolves `wantedChannelKind` against the live `channels` list on every
  // render, so a channel that was `[]` when a template applied is not stuck on
  // the empty string once `useDeliveryChannels` actually answers. Touched, it
  // is exactly what the person picked, which `channelFor` never overrides.
  const resolvedChannelId = channelTouched ? channelId : channelFor(wantedChannelKind);

  const reset = () => {
    setStep(1);
    setProse("");
    setName("");
    setSourceKind("none");
    setTriggerKind("schedule");
    setEventChoice(null);
    setConnectionId("");
    setInstruction("");
    setScheduleCron("0 * * * *");
    setTimezone(browserTimezone());
    setChannelId("");
    setChannelTouched(false);
    setWantedChannelKind(null);
    setDeliveryEmail("");
    setEmailTouched(false);
    setEmailError(null);
    setEndsAfterRuns(null);
    setFieldError(null);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const runDraft = async () => {
    setDrafting(true);
    try {
      const draft = await api.routines.draft(prose.trim(), browserTimezone());
      setName(draft.name);
      setSourceKind(draft.sourceKind);
      setInstruction(draft.instruction);
      // The draft calls it `cron`; the create endpoint calls it `scheduleCron`.
      setScheduleCron(draft.cron);
      setTimezone(draft.timezone);
      // channelKind is only a hint — the draft cannot know channel ids.
      // Recording the preference is all this does; `resolvedChannelId`
      // resolves it against the live `channels` list on every render, so it
      // need not have arrived yet.
      setWantedChannelKind(draft.channelKind);
      setChannelTouched(false);
    } catch (err) {
      // 422 means the parser could not read the request. Trapping the user on
      // step one retrying prose helps nobody; the form is always reachable.
      //
      // 503 is the model refusing rather than the words being unreadable, and
      // "couldn't read that one" blamed the person's sentence for it — with the
      // provider's account empty, every sentence (covan-ai/covan#350). The
      // server's own sentence says which it is; the form is still the way on.
      if (err instanceof ApiError && err.status === 503) {
        toast.error(`${err.message} You can fill it in below instead.`);
      } else {
        toast.message("Couldn't read that one — fill it in below instead.");
      }
      setWantedChannelKind(null);
      setChannelTouched(false);
    } finally {
      setDrafting(false);
      setStep(2);
    }
  };

  /**
   * A template is a draft that cost nothing.
   *
   * The same six assignments `runDraft` makes, from the same shape, without the
   * call — which is the whole of what a template is. `endsAfterRuns` is the one
   * field a drafted routine never has, because only a template knows a routine is
   * a series.
   */
  const applyTemplate = (template: RoutineTemplate) => {
    const d = template.draft;
    setName(d.name);
    setSourceKind(d.sourceKind);
    setInstruction(d.instruction);
    setScheduleCron(d.scheduleCron);
    setTimezone(browserTimezone());
    setEndsAfterRuns(template.endsAfterRuns);
    // Recording the preference, not resolving it — see `resolvedChannelId`'s
    // comment for why this is what fixes the deep-linked case `channels`
    // being `[]` on mount used to break.
    setWantedChannelKind(d.channelKind);
    setChannelTouched(false);
    setStep(2);
  };

  /**
   * The URL is a request, and this consumes it.
   *
   * An effect, and deliberately not derived state — `_authed.app.tsx:79-93` has
   * the long version of why, and both of its traps are waiting here. Deriving the
   * open state from the search param means the dialog stays open until the
   * router's update lands, TanStack does that in a transition, and closing
   * visibly lags on the deep-linked path and only on that path. A
   * `useState(!!openTemplate)` initialiser never sees a second press from the
   * same screen.
   *
   * An unknown id still consumes the request: the parameter has been read and
   * acted on, and leaving it in the URL would re-open this on every reopen.
   * Opening on step 1 is the right answer — it is the screen somebody who typed
   * a wrong URL wanted anyway.
   */
  useEffect(() => {
    if (!openTemplate) return;
    const template = templateById(openTemplate);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(true);
    if (template) {
      applyTemplate(template);
    } else {
      setWantedChannelKind(null);
      setChannelTouched(false);
    }
    onTemplateConsumed?.();
    // `channels` is deliberately not a dependency: it arrives a beat later,
    // and re-running this on its arrival would reopen a dialog the person had
    // closed. That used to be unsafe for a different reason — the comment
    // here used to claim the result was "the same state 'Set it up myself'
    // produces, which the empty-channel branch handles." It was not:
    // `skipToForm` runs on a click, long after `channels` has loaded, so that
    // path does preselect; and the empty-channel branch only covers
    // `channels.length === 0`, which on a workspace with a channel already
    // is exactly the case this was not. The actual fix is
    // `wantedChannelKind` + `resolvedChannelId` above: this effect only ever
    // records a preference, never resolves a channel id itself, so it has
    // nothing that `channels` arriving later could make stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTemplate]);

  const skipToForm = () => {
    setWantedChannelKind(null);
    setChannelTouched(false);
    setStep(2);
  };

  const save = async () => {
    setFieldError(null);
    setEmailError(null);
    try {
      const created = await createRoutine.mutateAsync({
        agentId,
        name: name.trim(),
        sourceKind,
        // Only a routine with no source of its own can be poked, and the
        // database refuses the pairing rather than trusting this. Sent as
        // `schedule` for every other kind, which is also what the state says —
        // the control that sets it is not rendered for them.
        triggerKind: sourceKind === "none" ? triggerKind : "schedule",
        ...(isEvent && eventChoice ? { event: eventChoice } : {}),
        connectionId: sourceKind === "connection" ? connectionId : null,
        instruction: instruction.trim(),
        ...(needsNewChannel
          ? { deliveryEmail: resolvedDeliveryEmail.trim() }
          : { deliveryChannelId: resolvedChannelId }),
        scheduleCron: scheduleCron.trim(),
        timezone,
        endsAfterRuns,
      });
      toast.success(
        created.confirmation
          ? "Routine created. We've emailed that address a link — nothing is sent there until it's confirmed."
          : "Routine created",
      );
      close();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not create that routine";
      // The API answers with a flat { error } string, so attributing it to a
      // field happens here. Both answers are distinctive enough to place with
      // confidence: the schedule validator answers exactly "unusable
      // schedule", the address check exactly "not an email address". A toast
      // for either would make the user hunt for which field it meant. There
      // used to be a branch for the URL guard's "unsafe url:", which stopped
      // being reachable when covan#241 took the URL field out — this dialog no
      // longer sends one.
      if (needsNewChannel && message === "not an email address") {
        setEmailError("That doesn't look like an email address.");
        return;
      }
      if (message.includes("unusable schedule")) {
        setFieldError({
          field: "schedule",
          message: "That schedule can't be read. Try 0 9 * * * for every day at 09:00.",
        });
        return;
      }
      toast.error(message);
    }
  };

  const canSave =
    name.trim() !== "" &&
    instruction.trim() !== "" &&
    (needsNewChannel ? resolvedDeliveryEmail.trim() !== "" : resolvedChannelId !== "") &&
    // The picker emits "" while a number field is mid-edit, so this also covers
    // "the user cleared the interval and has not typed the new one yet".
    scheduleCron.trim() !== "" &&
    scheduleError(scheduleCron) === null &&
    (!isEvent || eventChoiceReady(eventCatalog, eventChoice)) &&
    // Only a connected source has anything left to pick. `none` and `workspace`
    // need no further field, and the dialog cannot produce `rss` or `web` — it
    // used to require a URL for them with no input to type one into, which
    // left Create disabled with nothing the person could do about it.
    (sourceKind !== "connection" || connectionId !== "");

  return (
    <>
      <Button onClick={() => setOpen(true)} data-coach="new-routine">
        <Plus className="mr-1.5 h-4 w-4" /> New routine
      </Button>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{step === 1 ? "What should it do?" : "Check the details"}</DialogTitle>
          </DialogHeader>

          {step === 1 ? (
            <div className="space-y-4">
              <Textarea
                value={prose}
                onChange={(e) => setProse(e.target.value)}
                rows={4}
                placeholder="Check Jira for open high-priority bugs every morning at 9am and post a summary to Slack."
              />
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-meta text-muted-foreground">or start from one of these</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <TemplatePicker facts={facts} onPick={applyTemplate} />
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={skipToForm}>
                  Set it up myself
                </Button>
                <Button onClick={() => void runDraft()} disabled={!prose.trim() || drafting}>
                  {drafting ? "Reading…" : "Continue"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="routine-name">Name</Label>
                <Input id="routine-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              {/* Hidden rather than disabled for `workspace`: its items are
                  "Scheduled task" and "A connected source", a choice between
                  two kinds a person can set up from scratch on this screen.
                  `workspace` is neither - it only ever arrives from the
                  gap-report template, with no field here for a person to have
                  chosen it by hand - so a disabled item for it would offer a
                  third option to a control that is not where that option is
                  made, rather than explaining why the real two are grayed out.
                  Hiding the whole control also removes the actual bug:
                  without it, the trigger showed blank (no item's value is
                  "workspace") and picking either real item silently converted
                  the routine away from the one kind that cannot change back. */}
              {connections.length > 0 && sourceKind !== "workspace" && (
                <div className="space-y-2">
                  <Label htmlFor="routine-source">Source</Label>
                  <Select
                    value={sourceKind}
                    onValueChange={(v) => setSourceKind(v as CreatableSourceKind)}
                  >
                    <SelectTrigger id="routine-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Scheduled task</SelectItem>
                      <SelectItem value="connection">A connected source</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Offered only where it is valid. A routine that watches
                  something cannot also be poked — see 0055 for why the pairing
                  is refused rather than resolved — and, because a routine's
                  source can never change afterwards, this is a decision made
                  once, here. */}
              {sourceKind === "none" && (
                <div className="space-y-2">
                  <Label htmlFor="routine-trigger">Starts</Label>
                  <Select
                    value={triggerKind}
                    onValueChange={(v) => setTriggerKind(v as RoutineTriggerKind)}
                  >
                    <SelectTrigger id="routine-trigger">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="schedule">On its schedule</SelectItem>
                      <SelectItem value="webhook">When something calls it</SelectItem>
                      <SelectItem value="both">Either</SelectItem>
                      <SelectItem value="event">When something happens in an app</SelectItem>
                    </SelectContent>
                  </Select>
                  {(triggerKind === "webhook" || triggerKind === "both") && (
                    <p className="text-xs text-muted-foreground">
                      You will get a URL to paste into whatever should start it, and whatever it
                      POSTs is what the agent reads.
                    </p>
                  )}
                  {triggerKind === "event" && (
                    <p className="text-xs text-muted-foreground">
                      It runs each time the event happens, and the agent reads a short account of it
                      — who, what and when — rather than the raw data.
                    </p>
                  )}
                </div>
              )}

              {isEvent && (
                <EventPicker catalog={eventCatalog} value={eventChoice} onChange={setEventChoice} />
              )}

              {sourceKind === "connection" && (
                <div className="space-y-2">
                  <Label htmlFor="routine-connection">Connected source</Label>
                  <Select value={connectionId} onValueChange={setConnectionId}>
                    <SelectTrigger id="routine-connection">
                      <SelectValue placeholder="Pick a connection" />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.accountLabel}
                          {c.folderName ? ` · ${c.folderName}` : ""}
                          {c.bundleName ? ` → ${c.bundleName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* The one thing about this kind that will otherwise be
                      discovered as a bug. The routine reports what the sync has
                      already imported, so its own schedule cannot make it see a
                      change sooner than the connection does — an hourly routine
                      on a six-hourly connection is an hourly routine that finds
                      something roughly every six hours. */}
                  <p className="text-xs text-muted-foreground">
                    {syncCaveat(
                      connections.find((c) => c.id === connectionId)?.syncIntervalMinutes,
                    )}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="routine-instruction">Instruction</Label>
                <Textarea
                  id="routine-instruction"
                  rows={3}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </div>

              {!isEvent && (
                <>
                  <SchedulePicker value={scheduleCron} onChange={setScheduleCron} />
                  {fieldError?.field === "schedule" && (
                    <p className="text-xs text-destructive">{fieldError.message}</p>
                  )}
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="routine-tz">Time zone</Label>
                <Input
                  id="routine-tz"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={needsNewChannel ? "routine-channel-email" : "routine-channel"}>
                  Deliver to
                </Label>
                {channelsPending ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : needsNewChannel ? (
                  <>
                    <Input
                      id="routine-channel-email"
                      type="email"
                      placeholder="you@company.com"
                      value={resolvedDeliveryEmail}
                      onChange={(e) => {
                        setEmailTouched(true);
                        setDeliveryEmail(e.target.value);
                        setEmailError(null);
                      }}
                      aria-invalid={emailError !== null}
                      aria-describedby={emailError ? "routine-channel-email-error" : undefined}
                    />
                    {emailError && (
                      <p id="routine-channel-email-error" className="text-xs text-destructive">
                        {emailError}
                      </p>
                    )}
                    <p className="text-meta leading-[1.45] text-muted-foreground">
                      The result arrives here. You can add Slack or another address in Settings
                      later.
                    </p>
                  </>
                ) : (
                  <Select
                    value={resolvedChannelId}
                    onValueChange={(v) => {
                      setChannelTouched(true);
                      setChannelId(v);
                    }}
                  >
                    <SelectTrigger id="routine-channel">
                      <SelectValue placeholder="Pick a channel" />
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {sourceKind !== "none" && sourceKind !== "workspace" && (
                // Not decorative. diffItems treats a null cursor as a baseline
                // and returns nothing, so the first run is deliberately silent.
                // Without this line a user whose routine runs hourly sees
                // nothing for an hour and concludes the feature is broken.
                <p className="text-xs text-muted-foreground">
                  The first run just takes a snapshot — you'll start getting updates from the next
                  change onward.
                </p>
              )}

              {sourceKind === "workspace" && (
                // A `workspace` routine has no cursor and no diff — it reads a
                // rolling seven-day window and reports on it immediately
                // (coverage-source.ts; executor.ts's workspace branch). The
                // sentence above would be false here: there is no "next
                // change" to wait for, because the first run already is a
                // real report.
                <p className="text-xs text-muted-foreground">
                  This one doesn't wait for a next change — the first run already covers the past
                  week.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={() => void save()} disabled={!canSave || createRoutine.isPending}>
                  {createRoutine.isPending ? "Creating…" : "Create routine"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
