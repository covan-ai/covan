import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, type Me } from "@/lib/api-client";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { MODELS } from "@/lib/agent-meta";
import { SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Stands for "no preference" in a picker, which cannot hold an empty value. */
const NO_DEFAULT = "__none__";

/**
 * Two preferences that look alike and are not.
 *
 * Appearance is stored in this browser and applies to nobody else. The default
 * model is stored on the workspace and applies to everyone in it. Saying so on
 * the labels is cheaper than explaining it after someone changes the model
 * expecting it to be personal.
 */
export function PreferencesSection({ me }: { me: Me | undefined }) {
  const queryClient = useQueryClient();
  const { preference, mounted, setPreference } = useTheme();
  const [savingModel, setSavingModel] = useState(false);

  const defaultModel = me?.workspace.defaultModel ?? null;

  const saveDefaultModel = async (value: string) => {
    const next = value === NO_DEFAULT ? null : value;
    setSavingModel(true);
    try {
      await api.workspace.update({ defaultModel: next });
      toast.success(next ? `New agents will start on ${next}` : "Default model cleared");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      // RLS lets only admins write this, and the API turns that into a 403 with
      // a sentence rather than a silent no-op.
      const message = err instanceof ApiError ? err.message : "Failed to save the default";
      toast.error(message);
    } finally {
      setSavingModel(false);
    }
  };

  return (
    <section className="mt-16">
      <SectionHeading title="Preferences" />
      <SectionCard className="mt-6 space-y-5">
        <div className="space-y-2">
          <Label className="text-xs">Appearance</Label>
          <Select
            value={preference}
            onValueChange={(v) => setPreference(v as ThemePreference)}
            // Before mount the stored preference is unknown and the control
            // would render "System" for someone who chose Dark.
            disabled={!mounted}
          >
            <SelectTrigger className="max-w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">Follow the device</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Saved in this browser, for you — teammates keep their own.
          </p>
        </div>

        <div className="space-y-2 border-t border-hairline pt-5">
          <Label className="text-xs">Default model for new agents</Label>
          <Select
            value={defaultModel ?? NO_DEFAULT}
            onValueChange={saveDefaultModel}
            disabled={savingModel || !me}
          >
            <SelectTrigger className="max-w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEFAULT}>No preference</SelectItem>
              {MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Where the picker starts when anyone here creates an agent; each agent can still be
            changed afterwards. Applies to the whole workspace, and only admins can set it. The
            smaller models cost a fraction of the larger ones and are enough for most questions.
          </p>
        </div>

        <NotificationToggles />
      </SectionCard>
    </section>
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

  const set = async (key: "routinePaused" | "quotaExhausted", value: boolean) => {
    setSaving(key);
    try {
      const next = await api.notifications.update({ [key]: value });
      queryClient.setQueryData(["notification-preferences"], next);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save";
      toast.error(message);
      // Put the switch back where it was rather than leaving it showing a
      // setting the server never accepted.
      await queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
    } finally {
      setSaving(null);
    }
  };

  const rows = [
    {
      key: "routinePaused" as const,
      label: "A routine stops working",
      hint: "After repeated failures a routine pauses itself. Off means it pauses silently.",
    },
    {
      key: "quotaExhausted" as const,
      label: "A routine is waiting on your allowance",
      hint: "Sent once, not every time it tries.",
    },
  ];

  return (
    <div className="space-y-4 border-t border-hairline pt-5">
      <Label className="text-xs">Notify me when</Label>
      {rows.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm">{row.label}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.hint}</p>
          </div>
          <Switch
            checked={prefs ? prefs[row.key] : true}
            onCheckedChange={(v) => set(row.key, v)}
            disabled={!prefs || saving === row.key}
            aria-label={row.label}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Sent through the delivery channel the routine already uses. These are messages about a
        routine — the routine's own output is what it exists to send.
      </p>
    </div>
  );
}
