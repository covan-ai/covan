import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cronToProse } from "@/lib/cron-to-prose";
import {
  fromCron,
  toCron,
  MIN_MINUTES,
  type ScheduleForm,
  type ScheduleMode,
} from "@/lib/schedule-form";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The reason a schedule can't be saved, or null. Exported because the dialogs
 * own their own save buttons — the picker reports the schedule, it does not
 * decide whether the surrounding form is submittable.
 */
export function scheduleError(expr: string): string | null {
  const form = fromCron(expr);
  if (form?.mode === "minutes" && form.every < MIN_MINUTES) {
    return `The engine checks every ${MIN_MINUTES} minutes, so that is the shortest interval it can honour.`;
  }
  return null;
}

/**
 * Cron expressions never reach the screen. This offers the three shapes that
 * cover what routines are actually for, and hands the parent a cron string.
 *
 * An expression it cannot represent — the draft parser can emit `0 9 * * 1-5`,
 * and routines predating this picker carry whatever they were created with —
 * is shown as prose rather than silently rounded to the nearest shape it does
 * understand. Changing it is one click away; losing the user's actual schedule
 * to a redesign is not recoverable.
 */
export function SchedulePicker({
  value,
  onChange,
}: {
  /** A cron expression, or "" while a field is mid-edit. */
  value: string;
  onChange: (cron: string) => void;
}) {
  const seed = fromCron(value);
  const [overriding, setOverriding] = useState(false);

  // One remembered value per mode, so flipping between them to compare does not
  // wipe what was typed. Seeded once — both dialogs mount this with the
  // schedule already settled.
  const [mode, setMode] = useState<ScheduleMode>(seed?.mode ?? "hours");
  const [minutes, setMinutes] = useState(seed?.mode === "minutes" ? String(seed.every) : "15");
  const [hours, setHours] = useState(seed?.mode === "hours" ? String(seed.every) : "1");
  const [time, setTime] = useState(
    seed?.mode === "daily" ? `${pad(seed.hour)}:${pad(seed.minute)}` : "09:00",
  );

  const build = (next: {
    mode?: ScheduleMode;
    minutes?: string;
    hours?: string;
    time?: string;
  }): string => {
    const m = next.mode ?? mode;
    const count = (raw: string): number | null => {
      const n = Number(raw);
      return /^\d+$/.test(raw.trim()) && n >= 1 ? n : null;
    };

    let form: ScheduleForm | null = null;
    if (m === "minutes") {
      const every = count(next.minutes ?? minutes);
      // Out-of-floor values still build a cron, so the error below can name the
      // number the user actually typed instead of a silently corrected one.
      //
      // Above 59 is a different case and must not build one. `*/60 * * * *` is
      // not "every 60 minutes" — cron reads it as minute 0 of every hour — and
      // the server's isValidCron accepts it, so the routine would run on a
      // schedule nobody asked for. fromCron caps its step at 59 for the same
      // reason, which is why typing 60 also made this picker collapse to a raw
      // cron string mid-edit.
      form = every === null || every > 59 ? null : { mode: "minutes", every };
    } else if (m === "hours") {
      const every = count(next.hours ?? hours);
      form = every === null || every > 23 ? null : { mode: "hours", every };
    } else {
      const [h, mm] = (next.time ?? time).split(":");
      const hour = Number(h);
      const minute = Number(mm);
      form =
        Number.isInteger(hour) && Number.isInteger(minute) && hour <= 23 && minute <= 59
          ? { mode: "daily", hour, minute }
          : null;
    }
    // "" rather than a stale expression: an unfinished field must block the
    // save, not quietly submit whatever the schedule used to be.
    return form === null ? "" : toCron(form);
  };

  if (seed === null && value.trim() !== "" && !overriding) {
    return (
      <div className="space-y-2">
        <Label>Schedule</Label>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
          <span className="text-sm tabular-nums">{cronToProse(value)}</span>
          <Button variant="ghost" size="sm" onClick={() => setOverriding(true)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  const error = scheduleError(value);

  return (
    <div className="space-y-2">
      <Label htmlFor="routine-schedule-mode">Schedule</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as ScheduleMode;
            setMode(next);
            onChange(build({ mode: next }));
          }}
        >
          <SelectTrigger id="routine-schedule-mode" className="w-[13rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">Every N minutes</SelectItem>
            <SelectItem value="hours">Every N hours</SelectItem>
            <SelectItem value="daily">Every day at</SelectItem>
          </SelectContent>
        </Select>

        {mode === "minutes" && (
          <Input
            aria-label="Minutes between runs"
            className="w-24 tabular-nums"
            type="number"
            min={MIN_MINUTES}
            max={59}
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              onChange(build({ minutes: e.target.value }));
            }}
          />
        )}

        {mode === "hours" && (
          <Input
            aria-label="Hours between runs"
            className="w-24 tabular-nums"
            type="number"
            min={1}
            max={23}
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
              onChange(build({ hours: e.target.value }));
            }}
          />
        )}

        {mode === "daily" && (
          <Input
            aria-label="Time of day"
            className="w-32 tabular-nums"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              onChange(build({ time: e.target.value }));
            }}
          />
        )}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {value.trim() === "" ? "Pick how often this should run." : cronToProse(value)}
        </p>
      )}
    </div>
  );
}
