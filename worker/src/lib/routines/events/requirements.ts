/**
 * Whether what an event needs is connected, asked through the caller's own
 * client.
 *
 * Deliberately not the service role. "Is Gmail connected?" is a question about
 * what the person picking the event can see, and RLS already answers it: a
 * connection that is somebody else's (0098) or in another workspace is
 * absent here, so a routine cannot be pointed at a grant its owner could not
 * use. The adapter later subscribes with the service role, but only with the
 * connection id recorded here — which this read is what established.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRequirement } from "./catalog";

export type RequirementCheck =
  { ok: true; connectionId: string | null } | { ok: false; error: string };

/**
 * The connection an event would subscribe with, or why there is none.
 *
 * The first active one, when there are several. A workspace with two Gmail
 * accounts connected is rare enough that choosing between them is a later
 * decision, and recording the id means the choice made today does not move
 * under the routine if a second is connected tomorrow.
 */
export async function checkRequirement(
  db: SupabaseClient,
  workspaceId: string,
  requirement: EventRequirement,
  appName: string,
): Promise<RequirementCheck> {
  const missing = { ok: false, error: `Connect ${appName} first.` } as const;
  switch (requirement.kind) {
    case "none":
      return { ok: true, connectionId: null };
    case "composio": {
      const { data, error } = await db
        .from("tool_connections")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("transport", "composio")
        .eq("toolkit_slug", requirement.toolkit)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return { ok: false, error: "could not read your connected apps" };
      const id = (data as Array<{ id: string }> | null)?.[0]?.id;
      return id ? { ok: true, connectionId: id } : missing;
    }
    case "connection": {
      const { data, error } = await db
        .from("connections")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("provider", requirement.provider)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return { ok: false, error: "could not read your connections" };
      const id = (data as Array<{ id: string }> | null)?.[0]?.id;
      return id ? { ok: true, connectionId: id } : missing;
    }
    case "slack": {
      const { data, error } = await db
        .from("slack_installations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .limit(1);
      if (error) return { ok: false, error: "could not read the Slack installation" };
      const id = (data as Array<{ id: string }> | null)?.[0]?.id;
      return id ? { ok: true, connectionId: id } : missing;
    }
  }
}

/**
 * What is connected in this workspace, in one round of reads, for the
 * catalogue: which toolkits, which connection providers, and whether Slack is
 * installed. Failures read as "not connected", which costs the person one
 * Connect button they did not need rather than an error on a list.
 */
export async function connectedInWorkspace(
  db: SupabaseClient,
  workspaceId: string,
): Promise<(requirement: EventRequirement) => boolean> {
  const [tools, connections, slack] = await Promise.all([
    db
      .from("tool_connections")
      .select("toolkit_slug")
      .eq("workspace_id", workspaceId)
      .eq("transport", "composio")
      .eq("status", "active"),
    db
      .from("connections")
      .select("provider")
      .eq("workspace_id", workspaceId)
      .eq("status", "active"),
    db.from("slack_installations").select("id").eq("workspace_id", workspaceId).limit(1),
  ]);
  const toolkits = new Set(
    ((tools.data ?? []) as Array<{ toolkit_slug: string | null }>).map((r) => r.toolkit_slug),
  );
  const providers = new Set(
    ((connections.data ?? []) as Array<{ provider: string }>).map((r) => r.provider),
  );
  const slackInstalled = ((slack.data ?? []) as unknown[]).length > 0;

  return (requirement) => {
    switch (requirement.kind) {
      case "none":
        return true;
      case "composio":
        return toolkits.has(requirement.toolkit);
      case "connection":
        return providers.has(requirement.provider);
      case "slack":
        return slackInstalled;
    }
  };
}
