import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { SectionLabel } from "@/components/section";
import { Switch } from "@/components/ui/switch";
import type { Routine, UpdateRoutineInput } from "@/lib/routines-api";
import { Trans, useTranslation } from "@/i18n";

/**
 * Whether this routine may use the browser on its own.
 *
 * In a conversation every browser task is shown on a card and approved. A
 * scheduled run has nobody to show one to, so the approval is given here, once,
 * for every run — which is why it is off until the owner turns it on. On, a
 * run's browser carries what the owner's does in a conversation (0100, 0141).
 *
 * Presentational like `RoutineOutputCard`: the patch goes back through
 * `onSave`, and owner-only is the caller's decision.
 */
export function RoutineBrowserCard({
  routine,
  onSave,
  saving,
}: {
  routine: Routine;
  onSave: (patch: UpdateRoutineInput) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const on = routine.browserAccess === "all";

  return (
    <section className="mt-2">
      <SectionLabel>{t("Use a browser")}</SectionLabel>
      <p className="mt-0 mb-3 text-meta text-muted-foreground">
        {t("Let this routine open web pages on its own, and report what it found.")}
      </p>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="routine-browser" className="text-sm">
            {t("Allow the browser on scheduled runs")}
          </label>
          <Switch
            id="routine-browser"
            aria-label={t("Allow the browser on scheduled runs")}
            checked={on}
            onCheckedChange={(checked) => onSave({ browserAccess: checked ? "all" : "off" })}
            disabled={saving}
          />
        </div>

        {!on ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Runs cannot use the browser. Nobody is there to approve a task, so a run that needs a web page reports that it could not open one.",
            )}
          </p>
        ) : (
          <>
            <p className="flex items-start gap-2 text-sm">
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                {t(
                  "Each run's browser carries what yours does in a conversation: the sites you signed into in the browser panel, and the logins you saved.",
                )}
              </span>
            </p>

            <p className="text-meta text-muted-foreground">
              {t(
                "The report waits until the browser has answered, and is sent once with its answers in it.",
              )}
              {routine.browserConversationId && (
                <>
                  {" "}
                  <Trans
                    t={t}
                    i18nKey="The browser works beside <a>this routine's conversation</a>, where you can watch it or sign in for it."
                    components={{
                      a: (
                        <Link
                          to="/agents/$agentId/chat"
                          params={{ agentId: routine.agentId }}
                          search={{ s: routine.browserConversationId }}
                          className="underline underline-offset-2"
                        />
                      ),
                    }}
                  />
                </>
              )}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
