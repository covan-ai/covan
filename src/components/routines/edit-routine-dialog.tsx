import { useState } from "react";
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
import { SchedulePicker, scheduleError } from "@/components/routines/schedule-picker";
import type { DeliveryChannel, Routine, UpdateRoutineInput } from "@/lib/routines-api";

/**
 * Everything PATCH /routines/:id accepts, and nothing it does not.
 *
 * The source is deliberately absent. `routines.cursor` records how far this
 * routine has read *this* source, so repointing it would diff a new feed
 * against the old feed's seen keys — the endpoint refuses, and the form says
 * why instead of offering a field that cannot work.
 */
export function EditRoutineDialog({
  routine,
  channels,
  onSave,
  saving,
}: {
  routine: Routine;
  channels: DeliveryChannel[];
  onSave: (patch: UpdateRoutineInput) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(routine.name);
  const [instruction, setInstruction] = useState(routine.instruction);
  const [scheduleCron, setScheduleCron] = useState(routine.scheduleCron);
  const [timezone, setTimezone] = useState(routine.timezone);
  const [channelId, setChannelId] = useState(routine.deliveryChannelId);

  const reset = () => {
    setName(routine.name);
    setInstruction(routine.instruction);
    setScheduleCron(routine.scheduleCron);
    setTimezone(routine.timezone);
    setChannelId(routine.deliveryChannelId);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  // Only what actually moved. The PATCH handler recomputes next_run_at whenever
  // a schedule is present, so posting an unchanged one would reschedule the
  // routine as a side effect of fixing a typo in its name.
  const patch: UpdateRoutineInput = {};
  if (name.trim() !== routine.name) patch.name = name.trim();
  if (instruction.trim() !== routine.instruction) patch.instruction = instruction.trim();
  if (scheduleCron !== routine.scheduleCron) patch.scheduleCron = scheduleCron;
  if (timezone.trim() !== routine.timezone) patch.timezone = timezone.trim();
  if (channelId !== routine.deliveryChannelId) patch.deliveryChannelId = channelId;

  const canSave =
    Object.keys(patch).length > 0 &&
    name.trim() !== "" &&
    instruction.trim() !== "" &&
    timezone.trim() !== "" &&
    channelId !== "" &&
    scheduleCron.trim() !== "" &&
    scheduleError(scheduleCron) === null;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit routine</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-routine-name">Name</Label>
              <Input
                id="edit-routine-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Source</Label>
              <p className="truncate rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                {routine.sourceKind === "none" ? "Scheduled prompt" : routine.sourceUrl}
              </p>
              <p className="text-xs text-muted-foreground">
                A routine remembers how far it has read this source, so the source itself is fixed.
                To watch something else, delete it and make a new one.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-routine-instruction">Instruction</Label>
              <Textarea
                id="edit-routine-instruction"
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </div>

            <SchedulePicker value={scheduleCron} onChange={setScheduleCron} />

            <div className="space-y-2">
              <Label htmlFor="edit-routine-tz">Time zone</Label>
              <Input
                id="edit-routine-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-routine-channel">Deliver to</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger id="edit-routine-channel">
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
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!canSave || saving}
                onClick={() => {
                  onSave(patch);
                  setOpen(false);
                }}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
