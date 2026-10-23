import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { api, ApiError, type Me } from "@/lib/api-client";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { LOCALES } from "@/lib/locales";
import { applyLocale } from "@/i18n/provider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const { t } = useTranslation();
  const { preference, mounted, setPreference } = useTheme();

  // A16's Preferences as Field rows.
  return (
    <>
      <Field
        label={t("Theme")}
        help={t("System follows your device. Saved in this browser, for you.")}
      >
        <div className={mounted ? "" : "pointer-events-none opacity-50"}>
          <Segmented<ThemePreference>
            label={t("Theme")}
            value={preference}
            onChange={setPreference}
            options={[
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
              { value: "system", label: t("System") },
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (value: string) => {
    setSaving(true);
    try {
      const preference = value === FOLLOW_BROWSER ? null : value;
      await api.profile.update({ locale: preference });
      // Switch now rather than when /me comes back: the words on this very
      // page are the first thing the choice should change.
      applyLocale(preference);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Failed to save"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Field
      label={t("Language")}
      help={t("The interface. Agents answer in whatever language you write.")}
    >
      <Select
        value={locale ?? FOLLOW_BROWSER}
        onValueChange={(v) => void save(v)}
        disabled={saving}
      >
        <SelectTrigger aria-label={t("Language")} className="max-w-[420px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_BROWSER}>{t("Follow the browser")}</SelectItem>
          {/* Each language is named in itself ("English", "Türkçe"), the way
              every language picker does it, so the names are not translated. */}
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
  const { t } = useTranslation();
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
      const message = err instanceof ApiError ? err.message : t("Failed to save");
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
      label={t("Coverage report")}
      help={t(
        "A weekly report of topics nothing covered. It never shows names or anybody's question.",
      )}
    >
      <label className="flex items-center gap-3 pt-1 text-sm">
        <Switch
          checked={data ? data.excluded : false}
          onCheckedChange={setExcluded}
          disabled={!data || saving}
          aria-label={t("Exclude my questions from the coverage report")}
        />
        {t("Leave my questions out")}
      </label>
      {/* A switch left disabled with no sentence reads as "not for you". This
          is a consent control, so a failed read says so and offers the read
          again, rather than looking like a setting that does not apply. */}
      {isError && !data && (
        <p role="alert" className="mt-1 text-xs text-muted-foreground">
          {t("Couldn’t load this setting.")}{" "}
          <button
            type="button"
            className="underline underline-offset-2 disabled:opacity-50"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? t("Trying…") : t("Try again")}
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
  const { t } = useTranslation();
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
      const message = err instanceof ApiError ? err.message : t("Failed to save");
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
      label: t("An agent needs me and I have been away for an hour"),
      fallback: true,
    },
    { key: "routineFailed", label: t("A routine fails"), fallback: true },
    { key: "weeklySummary", label: t("Weekly summary, Monday morning"), fallback: false },
    {
      key: "routinePaused",
      label: t("A routine stops working and pauses itself"),
      fallback: true,
    },
    { key: "quotaExhausted", label: t("A routine is waiting on credits"), fallback: true },
  ];

  return (
    <Field label={t("Email me when")} help={t("Everything else stays in the Inbox.")}>
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
