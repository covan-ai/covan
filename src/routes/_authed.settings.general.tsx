import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { SectionLabel, SectionTitle } from "@/components/section";
import { Field } from "@/components/field";
import { Tile } from "@/components/tile";
import { Chip } from "@/components/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, ApiError } from "@/lib/api-client";
import { useWorkspaceRole } from "@/lib/workspace-role";
import {
  formatReplyPrice,
  modelLabel,
  modelTiers,
  modelsFor,
  priceFor,
  replyPricesOf,
} from "@/lib/agent-meta";
import { listTimeZones } from "@/lib/timezones";
import { workspaceIconSrc } from "@/lib/workspace-icon-src";

export const Route = createFileRoute("/_authed/settings/general")({
  component: GeneralSettingsPage,
  head: () => ({
    meta: [
      { title: "General — Settings — Covan" },
      {
        name: "description",
        content: "Your workspace's name, icon, default model, time zone and reports in Covan.",
      },
    ],
  }),
});

const NO_DEFAULT = "__none";

/**
 * Settings › General (A9): what the workspace is called and looks like, what
 * new agents start on, the clock routines keep, the reports it sends, and its
 * data — export, or deletion with fourteen days' notice. An admin's to
 * change; everybody else reads it.
 */
function GeneralSettingsPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { me, isAdmin: isAdminOnceKnown } = useWorkspaceRole();
  // True while `me` loads, so the page does not visibly lock and unlock on
  // every cold load. The server refuses anybody else's writes either way.
  const isAdmin = me ? isAdminOnceKnown : true;
  const ws = me?.workspace;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["me"] });

  const [name, setName] = useState<string | null>(null);
  const shownName = name ?? ws?.name ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const iconInput = useRef<HTMLInputElement>(null);

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
      await refresh();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Couldn't save that"));
    } finally {
      setBusy(null);
    }
  };

  const saveName = () => {
    const next = shownName.trim();
    if (!ws || !next || next === ws.name) return setName(null);
    void run("name", () => api.workspace.update({ name: next }), t("Name saved")).then(() =>
      setName(null),
    );
  };

  const prices = replyPricesOf(me);
  const models = modelsFor(me?.models, ws?.defaultModel ?? null);
  const tiers = modelTiers(models);
  const priceWords = (m: string) => {
    const p = priceFor(prices, m);
    return p ? ` · ${t("{{price}} per message", { price: formatReplyPrice(p) })}` : "";
  };
  const iconSrc = workspaceIconSrc(ws?.iconUrl ?? null);
  const deletesAt = ws?.deletesAt ?? null;

  return (
    <>
      <SectionTitle
        title={t("General")}
        lede={t(
          "The workspace everyone in {{workspace}} shares. Only owners and admins can change these.",
          { workspace: ws?.name ?? t("it", { context: "workspace", defaultValue: "it" }) },
        )}
      />

      <fieldset disabled={!isAdmin} className="mt-5 min-w-0">
        <Field
          label={t("Workspace name")}
          help={t("Shown in the sidebar and in invitation emails.")}
        >
          <Input
            aria-label={t("Workspace name")}
            className="max-w-[420px]"
            value={shownName}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setName(null);
            }}
          />
        </Field>

        <Field
          label={t("Icon")}
          help={t("A letter on a tile. Upload a square image to replace it.")}
        >
          <div className="flex items-center gap-3">
            <Tile label={ws?.name ?? "W"} size={36} tone="ink" letters={1} imageUrl={iconSrc} />
            <Button
              variant="secondary"
              onClick={() => iconInput.current?.click()}
              disabled={busy === "icon"}
            >
              {busy === "icon" ? t("Uploading…") : t("Upload image")}
            </Button>
            {ws?.iconUrl && (
              <Button
                variant="ghost"
                onClick={() =>
                  void run("icon", () => api.workspace.removeIcon(), t("Icon removed"))
                }
              >
                {t("Remove")}
              </Button>
            )}
            <input
              ref={iconInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={t("Choose an icon")}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void run("icon", () => api.workspace.setIcon(file), t("Icon updated"));
              }}
            />
          </div>
        </Field>

        <Field label={t("Workspace ID")} help={t("For support requests and the API.")}>
          <div className="flex items-center gap-2">
            <Chip tone="code">{ws?.id ?? "—"}</Chip>
            <Button
              variant="ghost"
              size="sm"
              disabled={!ws}
              onClick={() =>
                ws &&
                void navigator.clipboard
                  ?.writeText(ws.id)
                  .then(() => toast.success(t("Copied the workspace ID")))
              }
            >
              {t("Copy")}
            </Button>
          </div>
        </Field>

        <Field
          label={t("Default model tier")}
          help={t("New agents start here. Each agent can pick its own.")}
        >
          <Select
            value={ws?.defaultModel ?? NO_DEFAULT}
            onValueChange={(v) =>
              void run(
                "model",
                () => api.workspace.update({ defaultModel: v === NO_DEFAULT ? null : v }),
                t("Default saved"),
              )
            }
          >
            <SelectTrigger aria-label={t("Default model tier")} className="max-w-[420px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEFAULT}>{t("No preference")}</SelectItem>
              {tiers.map((tier) => (
                <SelectItem key={tier.model} value={tier.model}>
                  {tier.label}
                  {priceWords(tier.model)}
                </SelectItem>
              ))}
              {models
                .filter((m) => !tiers.some((tier) => tier.model === m))
                .map((m) => (
                  <SelectItem key={m} value={m}>
                    {modelLabel(m)}
                    {priceWords(m)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={t("Time zone")} help={t("Routines are scheduled in this time zone.")}>
          <Select
            value={ws?.timezone ?? "UTC"}
            onValueChange={(tz) =>
              void run("tz", () => api.workspace.update({ timezone: tz }), t("Time zone saved"))
            }
          >
            <SelectTrigger aria-label={t("Time zone")} className="max-w-[420px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {[...new Set([ws?.timezone ?? "UTC", ...listTimeZones()])].map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <SectionLabel>{t("Reports")}</SectionLabel>
        <Field
          label={t("Coverage report")}
          help={t(
            "Once a week, the topics the team asked about that no document covered. Every member is told it is on and can leave their questions out.",
          )}
        >
          <label className="flex items-center gap-3 pt-1 text-sm">
            <Switch
              aria-label={t("Coverage report")}
              checked={ws?.gapReportEnabled ?? false}
              onCheckedChange={(on) =>
                void run(
                  "coverage",
                  () => api.coverage.setEnabled(on),
                  on ? t("Report on") : t("Report off"),
                )
              }
            />
            <span className={ws?.gapReportEnabled ? "" : "text-muted-foreground"}>
              {ws?.gapReportEnabled ? t("On · Mondays") : t("Off")}
            </span>
          </label>
        </Field>
        <Field
          label={t("Weekly usage summary")}
          help={t(
            "Credits and threads per agent, sent to owners and admins by email on Monday morning.",
          )}
        >
          <label className="flex items-center gap-3 pt-1 text-sm">
            <Switch
              aria-label={t("Weekly usage summary")}
              checked={ws?.weeklyUsageEmail ?? false}
              onCheckedChange={(on) =>
                void run("weekly", () => api.workspace.update({ weeklyUsageEmail: on }))
              }
            />
            <span className={ws?.weeklyUsageEmail ? "" : "text-muted-foreground"}>
              {ws?.weeklyUsageEmail ? t("On") : t("Off")}
            </span>
          </label>
        </Field>

        <SectionLabel>{t("Data")}</SectionLabel>
        <Field
          label={t("Export workspace")}
          help={t(
            "Every thread, document and routine as a zip. Prepared in the background and sent to your email.",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={!ws || busy === "export"}
              onClick={() =>
                ws &&
                void run(
                  "export",
                  () => api.exports.request(ws.id),
                  t("Export requested — we'll email you when it's ready"),
                )
              }
            >
              {t("Request export")}
            </Button>
            <Link
              to="/settings/export"
              className="text-meta text-muted-foreground hover:text-foreground"
            >
              {t("Previous exports")}
            </Link>
          </div>
        </Field>
        <Field
          label={t("Delete workspace")}
          help={t(
            "Removes every agent, thread and document for everyone, after 14 days' notice. This cannot be undone.",
          )}
        >
          {deletesAt ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-destructive">
                {t("Deletes on {{date}}", {
                  date: new Date(deletesAt).toLocaleDateString(locale, {
                    day: "numeric",
                    month: "long",
                  }),
                })}
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  void run("cancel", () => api.workspace.cancelDeletion(), t("Deletion called off"))
                }
              >
                {t("Keep the workspace")}
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t("Delete workspace…")}
            </Button>
          )}
        </Field>
      </fieldset>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o);
          if (!o) setTyped("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Delete {{workspace}}?", { workspace: ws?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Every member is told now, and the workspace — its agents, threads, documents and routines — goes in 14 days. Until then one press keeps it. Type its name to go on.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label={t("Workspace name, to confirm")}
            placeholder={ws?.name}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              disabled={!ws || typed.trim() !== ws.name}
              onClick={() =>
                void run(
                  "delete",
                  () => api.workspace.requestDeletion(typed.trim()),
                  t("Deletion scheduled — everyone has been told"),
                )
              }
            >
              {t("Delete in 14 days")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
