import { useState } from "react";
import { englishT, lookup, msg, useTranslation, type Translate } from "@/i18n";
import { Chip } from "@/components/chip";
import { Input } from "@/components/ui/input";
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
import { listTimeZones } from "@/lib/timezones";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** Monday first, as a week is read; the number is cron's (0 = Sunday). */
const DAYS = [
  { n: 1, label: msg("Mon") },
  { n: 2, label: msg("Tue") },
  { n: 3, label: msg("Wed") },
  { n: 4, label: msg("Thu") },
  { n: 5, label: msg("Fri") },
  { n: 6, label: msg("Sat") },
  { n: 0, label: msg("Sun") },
];

const UNITS: Array<{ value: ScheduleMode; label: string }> = [
  { value: "minutes", label: msg("minutes") },
  { value: "hours", label: msg("hours") },
  { value: "daily", label: msg("day") },
  { value: "weekdays", label: msg("weekday") },
  { value: "weekly", label: msg("week") },
];

export function scheduleError(expr: string, t: Translate = englishT): string | null {
  const form = fromCron(expr);
  if (form?.mode === "minutes" && form.every < MIN_MINUTES) {
    return t(
      "The engine checks every {{count}} minute, so that is the shortest interval it can honour.",
      {
        count: MIN_MINUTES,
        defaultValue_other:
          "The engine checks every {{count}} minutes, so that is the shortest interval it can honour.",
      },
    );
  }
  return null;
}

/**
 * When a routine runs (A28): "Every [week] on [Mon … Sun] at [08:30]
 * [Europe/Istanbul]", then the schedule in words with its cron beside it and
 * "Edit as cron" for anything the row cannot say. Nobody is asked to write a
 * cron expression; anybody who wants to, can.
 */
export function SchedulePicker({
  value,
  onChange,
  timezone,
  onTimezone,
}: {
  /** A cron expression, or "" while a field is mid-edit. */
  value: string;
  onChange: (cron: string) => void;
  timezone?: string;
  onTimezone?: (tz: string) => void;
}) {
  const { t } = useTranslation();
  const seed = fromCron(value);
  // A schedule the row cannot draw opens as the cron it is, rather than being
  // rounded to something it is not.
  const [raw, setRaw] = useState(seed === null && value.trim() !== "");
  const [mode, setMode] = useState<ScheduleMode>(seed?.mode ?? "daily");
  const [minutes, setMinutes] = useState(seed?.mode === "minutes" ? String(seed.every) : "15");
  const [hours, setHours] = useState(seed?.mode === "hours" ? String(seed.every) : "1");
  const [time, setTime] = useState(
    seed && "hour" in seed ? `${pad(seed.hour)}:${pad(seed.minute)}` : "09:00",
  );
  const [days, setDays] = useState<number[]>(seed?.mode === "weekly" ? seed.days : [1]);

  const build = (next: {
    mode?: ScheduleMode;
    minutes?: string;
    hours?: string;
    time?: string;
    days?: number[];
  }): string => {
    const m = next.mode ?? mode;
    const count = (text: string): number | null => {
      const n = Number(text);
      return /^\d+$/.test(text.trim()) && n >= 1 ? n : null;
    };
    let form: ScheduleForm | null;
    if (m === "minutes") {
      const every = count(next.minutes ?? minutes);
      // Above 59 must not build one: `*/60 * * * *` is minute 0 of every hour.
      form = every === null || every > 59 ? null : { mode: "minutes", every };
    } else if (m === "hours") {
      const every = count(next.hours ?? hours);
      form = every === null || every > 23 ? null : { mode: "hours", every };
    } else {
      const [h, mm] = (next.time ?? time).split(":");
      const hour = Number(h);
      const minute = Number(mm);
      const okTime =
        Number.isInteger(hour) && Number.isInteger(minute) && hour <= 23 && minute <= 59;
      const picked = next.days ?? days;
      form = !okTime
        ? null
        : m === "weekly"
          ? picked.length === 0
            ? null
            : { mode: "weekly", days: picked, hour, minute }
          : { mode: m, hour, minute };
    }
    // "" rather than a stale expression: an unfinished field must block the
    // save, not quietly submit whatever the schedule used to be.
    return form === null ? "" : toCron(form);
  };

  const error = scheduleError(value, t);
  const sel = "h-8 w-auto gap-1.5";

  return (
    <div>
      {raw ? (
        <Input
          aria-label={t("Cron expression")}
          className="max-w-[220px] font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {t("Every", { context: "schedule", defaultValue: "Every" })}
          </span>
          {mode === "minutes" && (
            <Input
              aria-label={t("Minutes between runs")}
              className="w-20 tabular-nums"
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
              aria-label={t("Hours between runs")}
              className="w-20 tabular-nums"
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
          <Select
            value={mode}
            onValueChange={(v) => {
              const next = v as ScheduleMode;
              setMode(next);
              onChange(build({ mode: next }));
            }}
          >
            <SelectTrigger aria-label={t("How often")} className={sel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((u) => (
                <SelectItem key={u.value} value={u.value}>
                  {lookup(t, u.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mode === "weekly" && (
            <>
              <span className="text-muted-foreground">
                {t("on", { context: "schedule", defaultValue: "on" })}
              </span>
              <span role="group" aria-label={t("Days")} className="inline-flex gap-1">
                {DAYS.map((d) => {
                  const on = days.includes(d.n);
                  return (
                    <button
                      key={d.n}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? days.filter((x) => x !== d.n) : [...days, d.n];
                        setDays(next);
                        onChange(build({ days: next }));
                      }}
                      className={cn(
                        "grid h-[30px] w-9 place-items-center rounded-md border text-meta font-medium transition-colors",
                        on
                          ? "border-foreground bg-foreground text-background"
                          : "border-input bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {lookup(t, d.label)}
                    </button>
                  );
                })}
              </span>
            </>
          )}
          {(mode === "daily" || mode === "weekdays" || mode === "weekly") && (
            <>
              <span className="text-muted-foreground">
                {t("at", { context: "schedule", defaultValue: "at" })}
              </span>
              {/* Text, not `type="time"`, so it reads 08:30 whatever the
                  browser's locale would make of it (A28). */}
              <Input
                aria-label={t("Time of day")}
                className="w-[76px] tabular-nums"
                inputMode="numeric"
                placeholder="09:00"
                maxLength={5}
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  onChange(build({ time: e.target.value }));
                }}
              />
            </>
          )}
          {timezone !== undefined && onTimezone && (
            <Select value={timezone} onValueChange={onTimezone}>
              <SelectTrigger aria-label={t("Time zone")} className={sel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {[...new Set([timezone, ...listTimeZones()])].map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5 text-meta text-muted-foreground">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : value.trim() === "" ? (
          <span>{t("Pick how often this should run.")}</span>
        ) : (
          <>
            <span>{cronToProse(value, t)}</span>
            <Chip tone="code">{value}</Chip>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            // Back to the row: what the fields show becomes the schedule, so
            // nothing is saved that the person can no longer see.
            if (raw) onChange(build({}));
            setRaw(!raw);
          }}
          className="font-medium text-muted-foreground hover:text-foreground"
        >
          {raw ? t("Use the picker") : t("Edit as cron")}
        </button>
      </div>
    </div>
  );
}
