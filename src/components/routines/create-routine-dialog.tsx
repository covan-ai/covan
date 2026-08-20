import { useState } from "react";
import { Link as RouterLink } from "@tanstack/react-router";
import { Plus } from "lucide-react";
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
import { useDeliveryChannels, useCreateRoutine } from "@/hooks/use-routines";
import { SchedulePicker, scheduleError } from "@/components/routines/schedule-picker";

type SourceKind = "rss" | "web" | "none";

const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function CreateRoutineDialog({ agentId }: { agentId: string }) {
  const { data: channels = [] } = useDeliveryChannels();
  const createRoutine = useCreateRoutine();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [prose, setProse] = useState("");
  const [drafting, setDrafting] = useState(false);

  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("rss");
  const [sourceUrl, setSourceUrl] = useState("");
  const [instruction, setInstruction] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState(browserTimezone());
  const [channelId, setChannelId] = useState("");
  const [fieldError, setFieldError] = useState<{
    field: "schedule" | "url";
    message: string;
  } | null>(null);

  const reset = () => {
    setStep(1);
    setProse("");
    setName("");
    setSourceKind("rss");
    setSourceUrl("");
    setInstruction("");
    setScheduleCron("0 * * * *");
    setTimezone(browserTimezone());
    setChannelId("");
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
        sourceUrl: sourceKind === "none" ? null : sourceUrl.trim(),
        instruction: instruction.trim(),
        deliveryChannelId: channelId,
        scheduleCron: scheduleCron.trim(),
        timezone,
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
    channelId !== "" &&
    // The picker emits "" while a number field is mid-edit, so this also covers
    // "the user cleared the interval and has not typed the new one yet".
    scheduleCron.trim() !== "" &&
    scheduleError(scheduleCron) === null &&
    (sourceKind === "none" || sourceUrl.trim() !== "");

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
                placeholder="Scan r/SaaS every hour and email me a summary of new posts."
              />
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

              <div className="space-y-2">
                <Label htmlFor="routine-source">Source</Label>
                <Select value={sourceKind} onValueChange={(v) => setSourceKind(v as SourceKind)}>
                  <SelectTrigger id="routine-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rss">RSS / Atom feed</SelectItem>
                    <SelectItem value="web">Web page</SelectItem>
                    <SelectItem value="none">Scheduled prompt (no source)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {sourceKind !== "none" && (
                <div className="space-y-2">
                  <Label htmlFor="routine-url">URL</Label>
                  <Input
                    id="routine-url"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://www.reddit.com/r/SaaS/new/.rss"
                  />
                  {fieldError?.field === "url" && (
                    <p className="text-xs text-destructive">{fieldError.message}</p>
                  )}
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
                <Label htmlFor="routine-channel">Deliver to</Label>
                {channels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Add a delivery channel in Settings first —{" "}
                    <RouterLink to="/settings" className="text-primary underline">
                      open Settings
                    </RouterLink>
                    .
                  </p>
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
