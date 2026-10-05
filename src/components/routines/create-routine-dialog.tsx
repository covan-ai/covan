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
import { useDeliveryChannels, useCreateRoutine } from "@/hooks/use-routines";
import { useConnections } from "@/hooks/use-connections";
import { SchedulePicker, scheduleError } from "@/components/routines/schedule-picker";
import { TemplatePicker } from "@/components/routines/template-picker";
import type { RoutineSourceKind, RoutineTriggerKind } from "@/lib/routines-api";
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
  const { data: channels = [] } = useDeliveryChannels();
  // The one xor the "Deliver to" field turns on, named once rather than
  // repeated as `channels.length === 0` at every site that branches on it.
  const needsNewChannel = channels.length === 0;
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
  const [sourceKind, setSourceKind] = useState<RoutineSourceKind>("none");
  const [triggerKind, setTriggerKind] = useState<RoutineTriggerKind>("schedule");
  const [sourceUrl, setSourceUrl] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState(browserTimezone());
  const [channelId, setChannelId] = useState("");
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
  const [endsAfterRuns, setEndsAfterRuns] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: "schedule" | "url";
    message: string;
  } | null>(null);

  // What the field shows and what `save()` sends — the same expression, so
  // the two can never disagree. Untouched, it tracks `me.user.email` on every
  // render; touched, it is exactly what the person typed, including empty,
  // so clearing it to write a different address is never put back.
  const resolvedDeliveryEmail = emailTouched
    ? deliveryEmail
    : deliveryEmail || me?.user.email || "";

  const reset = () => {
    setStep(1);
    setProse("");
    setName("");
    setSourceKind("none");
    setTriggerKind("schedule");
    setSourceUrl("");
    setConnectionId("");
    setInstruction("");
    setScheduleCron("0 * * * *");
    setTimezone(browserTimezone());
    setChannelId("");
    setDeliveryEmail("");
    setEmailTouched(false);
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
      setSourceUrl(draft.sourceUrl ?? "");
      setInstruction(draft.instruction);
      // The draft calls it `cron`; the create endpoint calls it `scheduleCron`.
      setScheduleCron(draft.cron);
      setTimezone(draft.timezone);
      // channelKind is only a hint — the draft cannot know channel ids, so it
      // preselects the first channel of a matching kind if one exists.
      const wanted = draft.channelKind === "slack" ? "slack_webhook" : "email";
      setChannelId((channels.find((c) => c.kind === wanted) ?? channels[0])?.id ?? "");
    } catch {
      // 422 means the parser could not read the request. Trapping the user on
      // step one retrying prose helps nobody; the form is always reachable.
      toast.message("Couldn't read that one — fill it in below instead.");
      setChannelId(channels[0]?.id ?? "");
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
    setSourceUrl(d.sourceUrl ?? "");
    setInstruction(d.instruction);
    setScheduleCron(d.scheduleCron);
    setTimezone(browserTimezone());
    setEndsAfterRuns(template.endsAfterRuns);
    const wanted = d.channelKind === "slack" ? "slack_webhook" : "email";
    setChannelId((channels.find((c) => c.kind === wanted) ?? channels[0])?.id ?? "");
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
      setChannelId(channels[0]?.id ?? "");
    }
    onTemplateConsumed?.();
    // `channels` is read inside and deliberately not a dependency: it arrives a
    // beat later, and re-running this on its arrival would reopen a dialog the
    // person had closed. A template with no channel preselected is the same
    // state "Set it up myself" produces, which the empty-channel branch handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTemplate]);

  const skipToForm = () => {
    setChannelId(channels[0]?.id ?? "");
    setStep(2);
  };

  const save = async () => {
    setFieldError(null);
    try {
      await createRoutine.mutateAsync({
        agentId,
        name: name.trim(),
        sourceKind,
        // Only a routine with no source of its own can be poked, and the
        // database refuses the pairing rather than trusting this. Sent as
        // `schedule` for every other kind, which is also what the state says —
        // the control that sets it is not rendered for them.
        triggerKind: sourceKind === "none" ? triggerKind : "schedule",
        sourceUrl: sourceKind === "rss" || sourceKind === "web" ? sourceUrl.trim() : null,
        connectionId: sourceKind === "connection" ? connectionId : null,
        instruction: instruction.trim(),
        ...(needsNewChannel
          ? { deliveryEmail: resolvedDeliveryEmail.trim() }
          : { deliveryChannelId: channelId }),
        scheduleCron: scheduleCron.trim(),
        timezone,
        endsAfterRuns,
      });
      toast.success("Routine created");
      close();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not create that routine";
      // The API answers with a flat { error } string, so attributing it to a
      // field happens here. Both are distinctive enough to place with
      // confidence: the schedule validator answers exactly "unusable schedule",
      // and every SSRF-guard rejection is prefixed "unsafe url:". A toast for
      // one of these would make the user hunt for which field it meant.
      if (message.includes("unusable schedule")) {
        setFieldError({
          field: "schedule",
          message: "That schedule can't be read. Try 0 9 * * * for every day at 09:00.",
        });
        return;
      }
      if (message.startsWith("unsafe url:")) {
        setFieldError({ field: "url", message });
        return;
      }
      toast.error(message);
    }
  };

  const canSave =
    name.trim() !== "" &&
    instruction.trim() !== "" &&
    (needsNewChannel ? resolvedDeliveryEmail.trim() !== "" : channelId !== "") &&
    // The picker emits "" while a number field is mid-edit, so this also covers
    // "the user cleared the interval and has not typed the new one yet".
    scheduleCron.trim() !== "" &&
    scheduleError(scheduleCron) === null &&
    (sourceKind === "none" ||
      (sourceKind === "connection" ? connectionId !== "" : sourceUrl.trim() !== ""));

  return (
    <>
      <Button onClick={() => setOpen(true)}>
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

              {connections.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="routine-source">Source</Label>
                  <Select
                    value={sourceKind}
                    onValueChange={(v) => setSourceKind(v as RoutineSourceKind)}
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
                    </SelectContent>
                  </Select>
                  {triggerKind !== "schedule" && (
                    <p className="text-xs text-muted-foreground">
                      You will get a URL to paste into whatever should start it, and whatever it
                      POSTs is what the agent reads.
                    </p>
                  )}
                </div>
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

              <SchedulePicker value={scheduleCron} onChange={setScheduleCron} />
              {fieldError?.field === "schedule" && (
                <p className="text-xs text-destructive">{fieldError.message}</p>
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
                {needsNewChannel ? (
                  <>
                    <Input
                      id="routine-channel-email"
                      type="email"
                      placeholder="you@company.com"
                      value={resolvedDeliveryEmail}
                      onChange={(e) => {
                        setEmailTouched(true);
                        setDeliveryEmail(e.target.value);
                      }}
                    />
                    <p className="text-meta leading-[1.45] text-muted-foreground">
                      The result arrives here. You can add Slack or another address in Settings
                      later.
                    </p>
                  </>
                ) : (
                  <Select value={channelId} onValueChange={setChannelId}>
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

              {sourceKind !== "none" && (
                // Not decorative. diffItems treats a null cursor as a baseline
                // and returns nothing, so the first run is deliberately silent.
                // Without this line a user whose routine runs hourly sees
                // nothing for an hour and concludes the feature is broken.
                <p className="text-xs text-muted-foreground">
                  The first run just takes a snapshot — you'll start getting updates from the next
                  change onward.
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
