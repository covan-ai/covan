import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_PERSON_NOTES,
  MAX_TEAM_NOTES,
  type TeamBlockInput,
  type TeamPerson,
} from "./team-block";

const ROLES = new Set<TeamPerson["role"]>(["admin", "member", "viewer"]);

type NotesRead = PromiseLike<{ data: unknown; error: unknown }>;

/** One notes list, or `[]` and a log line when it could not be read. */
async function readNotes(which: string, query: () => NotesRead): Promise<string[]> {
  try {
    const { data, error } = await query();
    if (error) {
      console.error(`team context: could not read the ${which} notes`, error);
      return [];
    }
    return ((data ?? []) as { text: string | null }[]).flatMap((r) =>
      typeof r.text === "string" ? [r.text] : [],
    );
  } catch (err) {
    console.error(`team context: the ${which} notes read failed`, err);
    return [];
  }
}

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
 * The notes are read here too, each by an explicit filter, because a
 * service-role caller would otherwise be handed everyone's. The team's are
 * `scope = 'workspace'` in this workspace; the caller's own are
 * `scope = 'owner'` AND `created_by = callerId` in this workspace, and with no
 * caller, or when `personNotes` is false, that second read is not made at all.
 * `personNotes` has no default so each surface decides: a room other people
 * read must not carry one person's private notes, however well the asker is
 * known. Newest first, with the id as the
 * tie-break so the same rows always arrive in the same order (the prefix they
 * land in has to be byte-stable). Only `text` is selected.
 *
 * A notes read that fails costs that list and nothing else: it is logged and
 * the list is empty, and the roster and the other list still return.
 */
export async function loadTeamContext(
  db: SupabaseClient,
  input: { workspaceId: string; callerId: string | null; personNotes: boolean },
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

    // Started before the profiles read and awaited after it, so the three run
    // together. `readNotes` never rejects.
    const teamNotes = readNotes("team", () =>
      db
        .from("memory_notes")
        .select("text")
        .eq("workspace_id", input.workspaceId)
        .eq("scope", "workspace")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(MAX_TEAM_NOTES),
    );
    const callerId = input.callerId;
    const personNotes =
      callerId === null || !input.personNotes
        ? Promise.resolve<string[]>([])
        : readNotes("personal", () =>
            db
              .from("memory_notes")
              .select("text")
              .eq("workspace_id", input.workspaceId)
              .eq("created_by", callerId)
              .eq("scope", "owner")
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .limit(MAX_PERSON_NOTES),
          );

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
      teamNotes: await teamNotes,
      personNotes: await personNotes,
    };
  } catch (err) {
    console.error("team context: the read failed", err);
    return null;
  }
}
