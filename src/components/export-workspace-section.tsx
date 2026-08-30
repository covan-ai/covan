import { useState } from "react";
import { SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

/**
 * Taking the workspace with you.
 *
 * The README has always said a self-hosted Covan is the whole product and that
 * nothing is held hostage. That was true of the licence and true of the
 * database, and not true of the interface: the answer to "can I get my data
 * out" was `pg_dump`, which is an answer for whoever runs the server and not
 * for the team using it. This is the button that makes the claim checkable by
 * the person the claim was aimed at.
 *
 * Deliberately not gated on being an admin. An export is a read, and it
 * contains what this person could already see by clicking around — so refusing
 * it to a member would withhold a convenient copy of their own work, not
 * protect anything. What their file does *not* contain is anybody else's
 * private sessions, and the archive's manifest says so in its own words rather
 * than letting the filename imply otherwise.
 *
 * The whole archive lands in the browser before it is saved, which is what
 * fetching with a bearer token costs — an `<a href>` carries no Authorization
 * header. Fine for a workspace; the limit is the browser's memory, and the one
 * that would bite first is the Worker's, which is why the server streams.
 */
export function ExportWorkspaceSection({
  workspaceId,
  workspaceName,
}: {
  workspaceId?: string;
  workspaceName?: string;
}) {
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (busy || !workspaceId) return;
    setBusy(true);
    try {
      await api.workspace.exportArchive(workspaceId);
      toast.success("Export downloaded");
    } catch (e) {
      // No inline error state here, unlike closing an account: there is nothing
      // to go and fix and nothing to re-type. A failed export is a failed
      // request, and trying again is the whole remedy.
      toast.error(e instanceof ApiError ? e.message : "Could not build the export");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-14">
      <SectionHeading
        title="Take it with you"
        description="Everything this workspace holds, in one archive, with the SQL to put it back into a Covan you run yourself."
      />
      <SectionCard className="mt-6 space-y-5">
        <p className="text-sm text-muted-foreground">
          Agents and their personas, knowledge bundles, every document and its original file, chats
          and their messages, brainstorm boards, and routines with their schedules. Retrieval chunks
          are left out — they are rebuilt from the documents after a restore, and they would be the
          largest thing in the file by far.
        </p>
        <p className="text-sm text-muted-foreground">
          It holds what <span className="text-foreground">you</span> can see. Somebody else&rsquo;s
          private chats are not in your copy. Delivery channels come back without their secrets —
          those are encrypted with a key belonging to this install — so a restore brings every
          routine back <span className="text-foreground">paused</span>, waiting for its credential
          rather than failing on a schedule. The archive&rsquo;s{" "}
          <code className="text-xs">manifest.json</code> repeats all of this, so the file explains
          itself later, when nobody remembers this page.
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={download} disabled={busy || !workspaceId} variant="outline">
            {busy ? "Building the archive…" : "Download the archive"}
          </Button>
          {workspaceName ? (
            <span className="text-xs text-muted-foreground">
              Exports {workspaceName}, the workspace you are in.
            </span>
          ) : null}
        </div>
      </SectionCard>
    </section>
  );
}
