import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  FileText,
  Library,
  LogOut,
  MailPlus,
  ShieldCheck,
  Undo2,
  UserMinus,
  UserPlus,
  Trash2,
} from "lucide-react";
import { lookup, msg, Trans, useTranslation, type TFunction } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { SectionLabel } from "@/components/section";
import { Button } from "@/components/ui/button";
import { api, type WorkspaceEvent } from "@/lib/api-client";
import { formatRelative } from "@/lib/relative-time";

/**
 * Who did what, read off `workspace_events`.
 *
 * The rows are written by database triggers, not by the API, which is the point
 * of the whole arrangement: an audit log an API writes can be skipped by
 * anything that does not go through that API — and PostgREST, reachable with
 * the anon key in the browser bundle, does not. A trigger cannot be routed
 * around, and the table has no insert policy for anybody, so the log cannot be
 * forged either.
 *
 * Twelve actions, all of them things a person does deliberately to somebody
 * else's work or standing: deletions and their undos, role changes, joins and
 * departures, invitations sent and revoked. Not a change feed — editing an
 * agent's persona is not here, and adding it would bury the twelve that matter
 * under a stream nobody reads.
 */
export function WorkspaceActivitySection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? 100 : 12;

  const { data, isLoading } = useQuery({
    queryKey: ["workspace-events", limit],
    queryFn: () => api.events.list({ limit }),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  const events = data?.events ?? [];
  const someoneGone = t("Someone no longer here");

  // "Recent activity" on Team (A3): one 40px row per event — what, who, when.
  return (
    <section className="mt-10">
      <SectionLabel as="h2">{t("Recent activity")}</SectionLabel>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Once somebody deletes an agent, changes a role or sends an invitation, it lands here with their name on it — written by the database, so nothing that skips the app can skip it.",
          )}
        </p>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex min-h-10 items-center gap-3 border-b border-hairline px-1 text-sm"
              >
                <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
                  <EventIcon action={e.action} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <EventLine e={e} t={t} actor={e.actor ?? someoneGone} />
                </span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {formatRelative(e.createdAt, undefined, t, locale)}
                </span>
              </li>
            ))}
          </ul>
          {(data?.hasMore || expanded) && (
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
                {expanded ? t("Show less") : t("Show more")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EventIcon({ action }: { action: string }) {
  const cls = "h-4 w-4";
  if (action.endsWith(".restored")) return <Undo2 className={cls} />;
  if (action.startsWith("agent.")) return <Bot className={cls} />;
  if (action.startsWith("bundle.")) return <Library className={cls} />;
  if (action.startsWith("document.")) return <FileText className={cls} />;
  if (action === "member.role_changed") return <ShieldCheck className={cls} />;
  if (action === "member.joined") return <UserPlus className={cls} />;
  if (action === "member.left") return <LogOut className={cls} />;
  if (action === "member.removed") return <UserMinus className={cls} />;
  if (action.startsWith("invitation.")) return <MailPlus className={cls} />;
  return <Trash2 className={cls} />;
}

/** A role inside a sentence ("joined as member"), not the capitalised label. */
const ROLE_NOUN: Record<string, string> = {
  admin: msg("admin"),
  member: msg("member"),
  viewer: msg("viewer"),
};

/**
 * One sentence per event, in the past tense, naming the thing — with the
 * person who did it inside it, `<b>{{actor}}</b>`, because where the doer
 * stands in a sentence is the language's business, not this file's.
 *
 * `subjectLabel` is the name the thing had at the time, stored on the row
 * rather than joined — thirty days after a deletion the sweeper takes the row
 * and `subjectId` points nowhere, and a log that can only say "an agent was
 * deleted" is not a log.
 *
 * An unknown action has no sentence: the line prints the raw action rather
 * than swallowing it. It means the database learned to write one this file
 * has not learned to read, and showing it is how that gets noticed.
 */
function EventLine({ e, t, actor }: { e: WorkspaceEvent; t: TFunction; actor: string }) {
  const role = (e.detail?.role as string | undefined) ?? null;
  const roleNoun = (r: unknown) =>
    typeof r === "string" ? lookup(t, ROLE_NOUN[r] ?? r) : String(r);
  const line = sentenceKey(e.action, role);
  if (!line) {
    return (
      <>
        <span className="font-medium">{actor}</span> {e.action} — {e.subjectLabel}
      </>
    );
  }
  return (
    <Trans
      t={t}
      i18nKey={line.key}
      values={{
        actor,
        what: e.subjectLabel,
        role: role ? roleNoun(role) : "",
        from: roleNoun(e.detail?.from),
        to: roleNoun(e.detail?.to),
      }}
      components={{ b: <span className="font-medium" /> }}
    />
  );
}

/** The sentence's key, held in an object so `<Trans>` reads it as a lookup, not a literal. */
function sentenceKey(action: string, role: string | null): { key: string } | null {
  const key = sentenceFor(action, role);
  return key ? { key } : null;
}

function sentenceFor(action: string, role: string | null): string | null {
  switch (action) {
    case "agent.deleted":
      return msg("<b>{{actor}}</b> deleted the agent {{what}}");
    case "agent.restored":
      return msg("<b>{{actor}}</b> restored the agent {{what}}");
    case "bundle.deleted":
      return msg("<b>{{actor}}</b> deleted the knowledge bundle {{what}}");
    case "bundle.restored":
      return msg("<b>{{actor}}</b> restored the knowledge bundle {{what}}");
    case "document.deleted":
      return msg("<b>{{actor}}</b> deleted the document {{what}}");
    case "document.restored":
      return msg("<b>{{actor}}</b> restored the document {{what}}");
    case "member.role_changed":
      return msg("<b>{{actor}}</b> changed {{what}} from {{from}} to {{to}}");
    case "member.joined":
      return role
        ? msg("<b>{{actor}}</b> {{what}} joined as {{role}}")
        : msg("<b>{{actor}}</b> {{what}} joined");
    case "member.left":
      return msg("<b>{{actor}}</b> {{what}} left the workspace");
    case "member.removed":
      return msg("<b>{{actor}}</b> removed {{what}} from the workspace");
    case "invitation.created":
      return role
        ? msg("<b>{{actor}}</b> invited {{what}} as {{role}}")
        : msg("<b>{{actor}}</b> invited {{what}}");
    case "invitation.revoked":
      return msg("<b>{{actor}}</b> revoked the invitation to {{what}}");
    case "invitation.resent":
      return msg("<b>{{actor}}</b> sent a new invitation link to {{what}}");
    default:
      return null;
  }
}
