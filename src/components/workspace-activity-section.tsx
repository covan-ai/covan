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
import { SectionHeading } from "@/components/page-container";
import { DataRow, EmptyState } from "@/components/section-card";
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
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? 100 : 12;

  const { data, isLoading } = useQuery({
    queryKey: ["workspace-events", limit],
    queryFn: () => api.events.list({ limit }),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  const events = data?.events ?? [];

  return (
    <section className="mt-16">
      <SectionHeading
        title="What happened."
        turn="And who."
        description="Deletions, restores, roles and invitations. Written by the database rather than by the app, so nothing that skips the app can skip this."
      />

      <div className="mt-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : events.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Once somebody deletes an agent, changes a role or sends an invitation, it lands here with their name on it."
          />
        ) : (
          <>
            <ul className="flex flex-col gap-2.5">
              {events.map((e) => (
                <li key={e.id}>
                  <DataRow
                    icon={
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-hairline text-muted-foreground">
                        <EventIcon action={e.action} />
                      </span>
                    }
                    title={describe(e)}
                    meta={`${e.actor ?? "Someone no longer here"} · ${formatRelative(e.createdAt)}`}
                  />
                </li>
              ))}
            </ul>
            {(data?.hasMore || expanded) && (
              <div className="mt-4">
                <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
                  {expanded ? "Show less" : "Show more"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
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

/**
 * One sentence per event, in the past tense, naming the thing.
 *
 * `subjectLabel` is the name the thing had at the time, stored on the row
 * rather than joined — thirty days after a deletion the sweeper takes the row
 * and `subjectId` points nowhere, and a log that can only say "an agent was
 * deleted" is not a log.
 *
 * The default branch prints the raw action rather than swallowing it. An
 * unknown action means the database learned to write one this file has not
 * learned to read, and showing it is how that gets noticed.
 */
function describe(e: WorkspaceEvent): string {
  const what = e.subjectLabel;
  const role = (e.detail?.role as string | undefined) ?? null;

  switch (e.action) {
    case "agent.deleted":
      return `Deleted the agent ${what}`;
    case "agent.restored":
      return `Restored the agent ${what}`;
    case "bundle.deleted":
      return `Deleted the knowledge bundle ${what}`;
    case "bundle.restored":
      return `Restored the knowledge bundle ${what}`;
    case "document.deleted":
      return `Deleted the document ${what}`;
    case "document.restored":
      return `Restored the document ${what}`;
    case "member.role_changed":
      return `Changed ${what} from ${e.detail?.from} to ${e.detail?.to}`;
    case "member.joined":
      return `${what} joined${role ? ` as ${role}` : ""}`;
    case "member.left":
      return `${what} left the workspace`;
    case "member.removed":
      return `Removed ${what} from the workspace`;
    case "invitation.created":
      return `Invited ${what}${role ? ` as ${role}` : ""}`;
    case "invitation.revoked":
      return `Revoked the invitation to ${what}`;
    default:
      return `${e.action} — ${what}`;
  }
}
