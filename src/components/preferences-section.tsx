import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, type Me } from "@/lib/api-client";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { LOCALES } from "@/lib/locales";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Stands for "no preference" in a picker, which cannot hold an empty value. */
/** Stands for "follow the browser" in a picker, which cannot hold an empty value. */
const FOLLOW_BROWSER = "__browser__";

/**
 * Yours, and nobody else's.
 *
 * Appearance is stored in this browser and applies to nobody else; the two
 * notification switches and the coverage opt-out are stored against you. The
 * workspace's default model used to share this card, and the labels had to
 * explain that one of the four applied to everyone — it now lives on the
 * workspace page as `DefaultModelSection`, where that is what the page means.
 */
export function PersonalPreferencesSection({ me }: { me: Me | undefined }) {
  const { preference, mounted, setPreference } = useTheme();

  // A16's Preferences as Field rows.
  return (
    <>
      <Field label="Theme" help="System follows your device. Saved in this browser, for you.">
        <div className={mounted ? "" : "pointer-events-none opacity-50"}>
          <Segmented<ThemePreference>
            label="Theme"
            value={preference}
            onChange={setPreference}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </div>
      </Field>
      <LanguageField locale={me?.user.locale ?? null} />
      <NotificationToggles />
      <CoverageOptOut workspaceId={me?.workspace.id} />
    </>
  );
}

/** The interface's language; agents answer in whatever language you write. */
function LanguageField({ locale }: { locale: string | null }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (value: string) => {
    setSaving(true);
    try {
      await api.profile.update({ locale: value === FOLLOW_BROWSER ? null : value });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Field label="Language" help="The interface. Agents answer in whatever language you write.">
      <Select
        value={locale ?? FOLLOW_BROWSER}
        onValueChange={(v) => void save(v)}
        disabled={saving}
      >
        <SelectTrigger aria-label="Language" className="max-w-[420px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_BROWSER}>Follow the browser</SelectItem>
          {LOCALES.map((l) => (
            <SelectItem key={l.tag} value={l.tag}>
              {l.label}
            </SelectItem>
          ))}
          {/* A tag set elsewhere (the API takes any BCP 47 tag) still shows
              as itself rather than as a blank trigger. */}
          {locale && !LOCALES.some((l) => l.tag === locale) ? (
            <SelectItem value={locale}>{locale}</SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * The half `CoverageNotice` cannot offer.
 *
 * That notice (`coverage-notice.tsx`) is a one-shot thing: it is told once,
 * dismissed, and gone — which is exactly right for telling somebody, and
 * exactly wrong for a decision somebody should be able to revisit. This is
 * the other door into the same two routes Task 14 shipped
 * (`api.coverage.preference` / `setPreference`), reachable whether or not
 * anybody has ever seen the notice, and in both directions: it is the only
 * place a member who already excluded themselves can come back in.
 *
 * **Not gated on `gapReportEnabled`.** A member must be able to opt out
 * before the report is switched on — the notice's own test proves the route
 * "works while the report is off" — and this row is the second of the two
 * surfaces for the same guarantee. Only the notice itself is gated on
 * `enabled`, never this.
 *
 * **The query key carries `workspaceId`, the same way `CoverageNotice`'s
 * does.** The app switches workspaces without a reload, and this value is
 * consent-sensitive: an unscoped key would let a member who just switched
 * briefly see the *previous* workspace's exclusion state rendered under the
 * new workspace's name, until something else happened to evict it.
 * `workspace-queries.ts` is the belt for that (`"coverage"` is on
 * `WORKSPACE_SCOPED_QUERY_KEYS`, so a switch invalidates this too), and a
 * workspace-scoped key is the suspenders — the two are not redundant, because
 * the list invalidates by prefix on whatever key is live, and a key that
 * never named the workspace in the first place is the thing that let the
 * stale value survive long enough to render at all.
 */
function CoverageOptOut({ workspaceId }: { workspaceId: string | undefined }) {
  const queryClient = useQueryClient();
  const { data, isError, refetch, isFetching } = useQuery({
    queryKey: ["coverage", "preference", workspaceId],
    queryFn: api.coverage.preference,
  });
  const [saving, setSaving] = useState(false);

  const setExcluded = async (excluded: boolean) => {
    setSaving(true);
    try {
      await api.coverage.setPreference(excluded);
      queryClient.setQueryData(["coverage", "preference", workspaceId], { excluded });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save";
      toast.error(message);
      // Same recovery as `NotificationToggles`: put the switch back where the
      // server actually left it rather than leaving it showing a setting that
      // was never accepted.
      await queryClient.invalidateQueries({ queryKey: ["coverage", "preference", workspaceId] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Field
      label="Coverage report"
      help="A weekly report of topics nothing covered. It never shows names or anybody's question."
    >
      <label className="flex items-center gap-3 pt-1 text-sm">
        <Switch
          checked={data ? data.excluded : false}
          onCheckedChange={setExcluded}
          disabled={!data || saving}
          aria-label="Exclude my questions from the coverage report"
        />
        Leave my questions out
      </label>
      {/* A switch left disabled with no sentence reads as "not for you". This
          is a consent control, so a failed read says so and offers the read
          again, rather than looking like a setting that does not apply. */}
      {isError && !data && (
        <p role="alert" className="mt-1 text-xs text-muted-foreground">
          Couldn&rsquo;t load this setting.{" "}
          <button
            type="button"
            className="underline underline-offset-2 disabled:opacity-50"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Trying…" : "Try again"}
          </button>
        </p>
      )}
    </Field>
  );
}

/**
 * The two messages the engine sends about a routine, rather than from it. A
 * routine's actual output is not a notification and is not listed here — that
 * is the entire point of the routine, and switching it off is called deleting
 * it.
 */
function NotificationToggles() {
  const queryClient = useQueryClient();
  const { data: prefs } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: api.notifications.get,
  });
  const [saving, setSaving] = useState<string | null>(null);

  type Key = "needsMeAway" | "routineFailed" | "weeklySummary" | "routinePaused" | "quotaExhausted";
  const set = async (key: Key, value: boolean) => {
    setSaving(key);
    try {
      const next = await api.notifications.update({ [key]: value });
      queryClient.setQueryData(["notification-preferences"], next);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save";
      toast.error(message);
      await queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
    } finally {
      setSaving(null);
    }
  };

  // A16's three first; then the two about a routine's own health, which
  // were here before and still are.
  const rows: Array<{ key: Key; label: string; fallback: boolean }> = [
    {
      key: "needsMeAway",
      label: "An agent needs me and I have been away for an hour",
      fallback: true,
    },
    { key: "routineFailed", label: "A routine fails", fallback: true },
    { key: "weeklySummary", label: "Weekly summary, Monday morning", fallback: false },
    { key: "routinePaused", label: "A routine stops working and pauses itself", fallback: true },
    { key: "quotaExhausted", label: "A routine is waiting on credits", fallback: true },
  ];

  return (
    <Field label="Email me when" help="Everything else stays in the Inbox.">
      <div className="flex flex-col gap-2.5 pt-1">
        {rows.map((row) => (
          <label key={row.key} className="flex items-center gap-3 text-sm">
            <Switch
              checked={prefs ? prefs[row.key] : row.fallback}
              onCheckedChange={(v) => void set(row.key, v)}
              disabled={!prefs || saving === row.key}
              aria-label={row.label}
            />
            {row.label}
          </label>
        ))}
      </div>
    </Field>
  );
}
