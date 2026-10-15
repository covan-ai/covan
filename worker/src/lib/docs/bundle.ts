import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where a document the agent writes is filed: the agent's reports bundle.
 *
 * The server's half of `src/lib/reports.ts`, which found or made this bundle
 * in the browser before asking for a report. The agent can now ask for a
 * document itself, from a tool, with no browser in the loop, so the server has
 * to know the bundle too — by the same marker in the description, so the two
 * halves find the same bundle and never make a second one beside it. Names
 * belong to the user; the marker is what survives renaming the agent.
 *
 * Through the CALLER's client throughout, which is the whole permission check:
 * a viewer cannot insert a bundle or attach one (`can_write_in_workspace`,
 * 0021), and a bundle the caller cannot see is one they may not file into.
 */

const MARKER_PREFIX = "covan:reports:";

export function reportBundleMarker(agentId: string): string {
  return `${MARKER_PREFIX}${agentId}`;
}

export function reportBundleName(agentName: string): string {
  return `${agentName} — reports`;
}

export type BundleResult = { ok: true; bundleId: string } | { ok: false; reason: string };

export async function ensureReportBundle(
  db: SupabaseClient,
  input: { workspaceId: string; agentId: string; agentName: string; userId: string },
): Promise<BundleResult> {
  const marker = reportBundleMarker(input.agentId);

  const { data: found, error: findError } = await db
    .from("knowledge_bundles")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("description", marker)
    .is("deleted_at", null)
    .order("created_at")
    .limit(1);
  if (findError) return { ok: false, reason: `could not look up the reports bundle` };

  let bundleId = found?.[0]?.id as string | undefined;
  if (!bundleId) {
    const { data: made, error: makeError } = await db
      .from("knowledge_bundles")
      .insert({
        workspace_id: input.workspaceId,
        name: reportBundleName(input.agentName),
        description: marker,
        created_by: input.userId,
      })
      .select("id")
      .single();
    // RLS answers a viewer by refusing the insert, which is the refusal the
    // person should hear — in words, not as a 500.
    if (makeError || !made) {
      return { ok: false, reason: "you can read this workspace but not write documents into it" };
    }
    bundleId = made.id as string;
  }

  // Attached, or the Knowledge tab never shows it: that list is every document
  // in every attached bundle. An unattached report would be a file with no
  // screen. Upsert-shaped by hand, because a second attach is a unique
  // violation rather than a no-op.
  const { data: link } = await db
    .from("agent_bundles")
    .select("bundle_id")
    .eq("agent_id", input.agentId)
    .eq("bundle_id", bundleId)
    .maybeSingle();
  if (!link) {
    const { error: attachError } = await db
      .from("agent_bundles")
      .insert({ agent_id: input.agentId, bundle_id: bundleId });
    if (attachError && attachError.code !== "23505") {
      return { ok: false, reason: "could not attach the reports bundle to this agent" };
    }
  }

  return { ok: true, bundleId };
}
