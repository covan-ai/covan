import type { SupabaseClient } from "@supabase/supabase-js";
import type { TeamBlockInput, TeamPerson } from "./team-block";

const ROLES = new Set<TeamPerson["role"]>(["admin", "member", "viewer"]);

/**
 * Who is on a workspace's team, as the input `teamBlock` renders.
 *
 * Takes whichever client the caller holds: a person's own RLS client on the
 * chat path, the service role on Slack's. Because the second sees every row in
 * the database, nothing here leans on RLS to decide what belongs — each read
 * names the workspace, and the profiles are fetched by the ids the membership
 * read returned, so a service-role caller gets this workspace's people and no
 * one else's.
 *
 * `profiles` is read by column and never by `*`: the table carries the email
 * address, which a prompt has no business holding.
 *
 * Best-effort, like every part of the prefix that is not the question. A turn
 * must not fail because the roster could not be read, so any error is logged
 * and the answer is null, which the caller treats as "no team block". A
 * workspace row that is not there is the same answer: the block opens with the
 * workspace's name and there is nothing true to open with.
 *
 * The note lists are empty here. They arrive with the table that holds them.
 */
export async function loadTeamContext(
  db: SupabaseClient,
  input: { workspaceId: string; callerId: string | null },
): Promise<TeamBlockInput | null> {
  try {
    const [workspace, members] = await Promise.all([
      db.from("workspaces").select("name").eq("id", input.workspaceId).maybeSingle(),
      db.from("workspace_members").select("user_id, role").eq("workspace_id", input.workspaceId),
    ]);
    if (workspace.error || members.error) {
      console.error("team context: could not read the workspace", workspace.error ?? members.error);
      return null;
    }
    const name = (workspace.data as { name: string | null } | null)?.name;
    if (!name) return null;

    const rows = (members.data ?? []) as { user_id: string; role: string }[];
    const ids = rows.map((r) => r.user_id);

    const profiles = new Map<
      string,
      { name: string | null; bio: string | null; timezone: string | null }
    >();
    if (ids.length > 0) {
      const { data, error } = await db
        .from("profiles")
        .select("id, name, bio, timezone")
        .in("id", ids);
      if (error) {
        console.error("team context: could not read the profiles", error);
        return null;
      }
      for (const p of (data ?? []) as {
        id: string;
        name: string | null;
        bio: string | null;
        timezone: string | null;
      }[]) {
        profiles.set(p.id, p);
      }
    }

    const people: TeamPerson[] = rows.flatMap((r) => {
      // The column is constrained to these three; anything else is a row this
      // code does not understand, and a wrong role in a prompt is worse than
      // a missing person.
      if (!ROLES.has(r.role as TeamPerson["role"])) return [];
      const p = profiles.get(r.user_id);
      return [
        {
          id: r.user_id,
          name: p?.name ?? null,
          bio: p?.bio ?? null,
          timezone: p?.timezone ?? null,
          role: r.role as TeamPerson["role"],
        },
      ];
    });

    return {
      workspaceName: name,
      people,
      callerId: input.callerId,
      teamNotes: [],
      personNotes: [],
    };
  } catch (err) {
    console.error("team context: the read failed", err);
    return null;
  }
}
