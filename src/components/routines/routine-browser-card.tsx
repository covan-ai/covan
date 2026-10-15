import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
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
import type { Routine, UpdateRoutineInput } from "@/lib/routines-api";

/**
 * Whether this routine may use the browser on its own, and what it carries.
 *
 * In a conversation every browser task is shown on a card and approved. A
 * scheduled run has nobody to show one to, so the approval is given here, once,
 * for every run — which is why it is off until the owner turns it on.
 *
 * The choice under it is about what an unattended browser can reach, because a
 * feed entry or a watched page reaches the model, and the model writes the
 * browser's instruction:
 *
 *  - **Everything, as in chat** — the owner's browser sign-ins and any login
 *    they saved, by the rules a conversation's browser follows.
 *  - **One site's saved login only** — a browser with none of the owner's
 *    sign-ins in it, carrying one saved login, typed on that site only.
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
  const on = routine.browserAccess !== "off";
  // The site is typed, so it is saved on demand rather than on every key. Null
  // is "nothing typed", which shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const site = draft ?? routine.browserSite ?? "";
  const siteChanged = site.trim() !== (routine.browserSite ?? "");
  // "One site" picked before any site was named: show the field, save
  // nothing. Only meaningful while the saved choice is still `all`.
  const [picking, setPicking] = useState(false);
  const pickingSite = picking && routine.browserAccess === "all";
  const setPickingSite = setPicking;
  const saveSite = () => {
    onSave({ browserAccess: "site", browserSite: site.trim() });
    setDraft(null);
    setPicking(false);
  };

  return (
    <section className="mt-10">
      <SectionHeading
        title="Use a browser"
        description="Let this routine open web pages on its own, and report what it found."
      />

      <SectionCard className="mt-3 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="routine-browser" className="text-sm">
            Allow the browser on scheduled runs
          </label>
          <Switch
            id="routine-browser"
            aria-label="Allow the browser on scheduled runs"
            checked={on}
            // Turning it on starts with what chat does, unless a site was
            // already named — then the narrower choice comes back as it was.
            onCheckedChange={(checked) =>
              onSave({
                browserAccess: checked ? (routine.browserSite ? "site" : "all") : "off",
              })
            }
            disabled={saving}
          />
        </div>

        {!on ? (
          <p className="text-sm text-muted-foreground">
            Runs cannot use the browser. Nobody is there to approve a task, so a run that needs a
            web page reports that it could not open one.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground" htmlFor="routine-browser-access">
                What the browser may use
              </label>
              <Select
                value={pickingSite ? "site" : routine.browserAccess}
                onValueChange={(value) => {
                  if (value === "site" && !site.trim()) {
                    // Nothing to save yet: the site field below appears, and
                    // saving it saves the choice with it.
                    setPickingSite(true);
                    return;
                  }
                  setPickingSite(false);
                  onSave(
                    value === "site"
                      ? { browserAccess: "site", browserSite: site.trim() }
                      : { browserAccess: "all" },
                  );
                }}
                disabled={saving}
              >
                <SelectTrigger id="routine-browser-access" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everything, as in a conversation</SelectItem>
                  <SelectItem value="site">One site's saved login only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <SiteField
              visible={routine.browserAccess === "site" || pickingSite}
              site={site}
              onChange={setDraft}
              onSave={saveSite}
              canSave={Boolean(site.trim()) && (siteChanged || routine.browserAccess !== "site")}
              saving={saving}
            />

            <p className="flex items-start gap-2 text-sm">
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              {routine.browserAccess === "site" || pickingSite ? (
                <span>
                  Each run's browser starts with none of your sign-ins. It is given only your saved
                  login for{" "}
                  <strong className="font-medium">{routine.browserSite ?? "that site"}</strong>, and
                  can type it on that site and nowhere else.
                </span>
              ) : (
                <span>
                  Each run's browser carries what yours does in a conversation: the sites you signed
                  into in the browser panel, and the logins you saved. Choose one site's login only
                  if this routine reads feeds or pages other people write.
                </span>
              )}
            </p>

            <p className="text-xs text-muted-foreground">
              The report waits until the browser has answered, and is sent once with its answers in
              it.
              {routine.browserConversationId && (
                <>
                  {" "}
                  The browser works beside{" "}
                  <Link
                    to="/agents/$agentId/chat"
                    params={{ agentId: routine.agentId }}
                    search={{ s: routine.browserConversationId }}
                    className="underline underline-offset-2"
                  >
                    this routine's conversation
                  </Link>
                  , where you can watch it or sign in for it.
                </>
              )}
            </p>
          </>
        )}
      </SectionCard>
    </section>
  );
}

/** The one-site field, shown once that choice is made or being made. */
function SiteField({
  visible,
  site,
  onChange,
  onSave,
  canSave,
  saving,
}: {
  visible: boolean;
  site: string;
  onChange: (value: string) => void;
  onSave: () => void;
  canSave: boolean;
  saving: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="space-y-2">
      <label className="text-xs text-muted-foreground" htmlFor="routine-browser-site">
        The site it may sign in to
      </label>
      <div className="flex gap-2">
        <Input
          id="routine-browser-site"
          value={site}
          placeholder="linkedin.com"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) onSave();
          }}
          disabled={saving}
        />
        <Button variant="outline" onClick={onSave} disabled={!canSave || saving}>
          Save
        </Button>
      </div>
    </div>
  );
}
