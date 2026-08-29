import { Hono } from "hono";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getDocStore } from "../lib/docstore";

/**
 * Closing an account.
 *
 * This is the one right that is not negotiable — GDPR Article 17 and the KVKK
 * both make erasure a thing a person may demand rather than a feature an
 * operator may offer — and until now the interface had no way to ask for it.
 * The schema has been ready since `0016_deletable_users_and_workspaces.sql`,
 * which removed six foreign keys that refused the cascade; what was missing was
 * a door, and this file is it.
 *
 * Most of what follows is the database's work. `auth.users` cascades to
 * memberships, sessions, messages, favorites, notifications and API keys, and
 * the six attribution columns `0016` converted go to null rather than taking
 * the row with them — a workspace does not evaporate because the person who
 * opened it left.
 *
 * The exception is object storage, and it is the one thing here that has to be
 * done by hand. No stored object belongs to a *person* — `documents.r2_key` is
 * the only key in the schema and `documents` hangs off a bundle, which hangs
 * off a workspace — but this route deletes workspaces too, and a workspace
 * cascade takes the rows that name the keys while leaving the bytes. For an
 * ordinary delete `documents.ts` calls that an acceptable storage cost. For
 * erasure it is not a cost, it is the files still being there. So the keys are
 * collected before the rows go, exactly as `docs/team.md` warns an operator to
 * do, because afterwards there is nothing left to enumerate them by.
 */
const account = new Hono<AppEnv>();

type Membership = { workspace_id: string; role: string };
type Member = { workspace_id: string; user_id: string; role: string };

/**
 * What happens to the rooms somebody was in.
 *
 * `prevent_last_admin_removal` (`0016`) refuses to delete a `workspace_members`
 * row when the workspace still exists, the row is an admin, and no other admin
 * remains. It is doing the right thing for the case it was written for — a
 * member walking out of a team — but it asks nothing about how many people are
 * left, and everybody starts as the sole admin of their own workspace. Left
 * alone it would refuse every account deletion there will ever be, including
 * one from a person who never invited anybody.
 *
 * So the two cases are told apart here, once, rather than by the trigger:
 *
 * - **Somebody else is still in it.** Refused, and the workspace is named. This
 *   is the product answer `0016` left open and `0020` had already chosen for
 *   leaving: block until the role is handed over. A workspace full of people
 *   must not lose its last admin, and it must not be silently handed to whoever
 *   joined first either.
 * - **Nobody else is in it.** The workspace is deleted with the account. There
 *   is no role to hand over and nobody to hand it to; keeping it would leave a
 *   room that no living person can enter, still holding the agents and
 *   documents of somebody who asked to be forgotten.
 *
 * A sole member who is somehow not an admin lands in the second case too. The
 * trigger would allow that row to go and leave an empty workspace behind, which
 * is the same unreachable remains by a different route.
 */
export function planWorkspaces(
  userId: string,
  memberships: Membership[],
  members: Member[],
): { blocked: string[]; deletable: string[] } {
  const blocked: string[] = [];
  const deletable: string[] = [];

  for (const { workspace_id: id } of memberships) {
    const others = members.filter((m) => m.workspace_id === id && m.user_id !== userId);
    if (others.length === 0) {
      deletable.push(id);
      continue;
    }
    const mine = members.find((m) => m.workspace_id === id && m.user_id === userId);
    const otherAdmins = others.filter((m) => m.role === "admin");
    if (mine?.role === "admin" && otherAdmins.length === 0) blocked.push(id);
  }

  return { blocked, deletable };
}

/**
 * Every stored object about to lose the row that names it.
 *
 * Best-effort on the read as well as the write: a workspace whose bundles or
 * documents cannot be listed still gets deleted, because refusing to close an
 * account over a storage bookkeeping problem would be the worse failure. What
 * it costs is bytes nobody can reach, and the log line says which.
 */
async function collectDocumentKeys(
  admin: ReturnType<typeof serviceClient>,
  workspaceIds: string[],
): Promise<string[]> {
  if (workspaceIds.length === 0) return [];

  const { data: bundles, error: bundlesError } = await admin
    .from("knowledge_bundles")
    .select("id")
    .in("workspace_id", workspaceIds);

  if (bundlesError) {
    console.error("account deletion: could not list bundles to clean up", bundlesError);
    return [];
  }

  const bundleIds = (bundles ?? []).map((b) => b.id as string);
  if (bundleIds.length === 0) return [];

  const { data: docs, error: docsError } = await admin
    .from("documents")
    .select("r2_key")
    .in("bundle_id", bundleIds);

  if (docsError) {
    console.error("account deletion: could not list documents to clean up", docsError);
    return [];
  }

  return (docs ?? []).map((d) => d.r2_key as string | null).filter((k): k is string => !!k);
}

// DELETE /account — close your own account, and nothing else's.
account.delete("/account", async (c) => {
  // The third refusal in the family, and the heaviest of the three. The other
  // two live in `routes/api-keys.ts`: a key may not mint another key and may not
  // revoke one. All three exist because a key is not a scope list — it is a way
  // to become the person who owns it — so "acting as the owner" would otherwise
  // be enough to end the owner. A leaked key that can close the account it came
  // from destroys the evidence and the account in one call, and no revocation
  // afterwards can undo it. This one is not optional and it is not derivable:
  // it has to be written, here, by hand.
  if (c.get("apiKeyId")) {
    return c.json({ error: "api keys cannot close an account — sign in to do this" }, 403);
  }

  const db = c.get("db");
  const user = c.get("user");

  const { data: memberships, error: membershipsError } = await db
    .from("workspace_members")
    .select("workspace_id,role")
    .eq("user_id", user.id);

  if (membershipsError) return c.json({ error: "failed to check your workspaces" }, 500);

  const ids = (memberships ?? []).map((m) => m.workspace_id as string);

  // Read through the caller's own client, not the service one. Being able to
  // see the other members of these workspaces is exactly what
  // `workspace_members_select_fellow_members` grants, so the survey is scoped
  // by the same rule the team screen is — and if the caller is somehow not a
  // member of one of these, the row it would have relied on is simply absent.
  let members: Member[] = [];
  if (ids.length > 0) {
    const { data, error } = await db
      .from("workspace_members")
      .select("workspace_id,user_id,role")
      .in("workspace_id", ids);
    if (error) return c.json({ error: "failed to check your workspaces" }, 500);
    members = (data ?? []) as Member[];
  }

  const { blocked, deletable } = planWorkspaces(
    user.id,
    (memberships ?? []) as Membership[],
    members,
  );

  if (blocked.length > 0) {
    // Named, not counted. "You are the last admin of 2 workspaces" sends a
    // person hunting through a switcher; the dialog can only say what to go and
    // fix if this says which. The names are read separately because the survey
    // above deliberately does not join — it is about roles, not labels.
    const { data: rows } = await db.from("workspaces").select("id,name").in("id", blocked);
    const names = (rows ?? []).map((r) => r.name as string).filter(Boolean);
    return c.json(
      {
        error:
          "make someone else an admin first — a workspace cannot be left without one: " +
          (names.length > 0 ? names.join(", ") : blocked.join(", ")),
        workspaces: names,
      },
      409,
    );
  }

  const admin = serviceClient(c.env);

  // Read while the rows still exist, and thrown away if anything below refuses.
  // Two hops rather than a join, because the cascade is two hops: a document
  // names a bundle and a bundle names the workspace.
  const keys = await collectDocumentKeys(admin, deletable);

  // Deleted before the user, and one at a time. Before, because the trigger
  // refuses the membership row while the workspace is still standing, and the
  // membership row is what the user's cascade has to remove. One at a time
  // because a failure part-way through should leave the rest of the account
  // intact and the caller told, rather than half a person in the database.
  for (const id of deletable) {
    // Two references to a workspace do not cascade, and this is the procedure
    // `docs/team.md` documents for an operator deleting one by hand.
    // `chat_sessions.workspace_id` and `ideas.workspace_id` were both added
    // after the original schema as plain references, so a workspace with a
    // single conversation in it cannot be deleted until they are cleared —
    // which is every workspace anybody has used. Scoped by workspace rather
    // than by user on purpose: a session belonging to somebody who was removed
    // from this workspace still carries its `workspace_id` and would hold the
    // delete open just the same.
    //
    // Better fixed as a migration that makes both cascade, which would also
    // simplify the operator procedure. Done here instead because the route has
    // to work against a database that has not had that migration applied, and
    // migrations reach production by hand.
    for (const table of ["ideas", "chat_sessions"] as const) {
      const { error } = await admin.from(table).delete().eq("workspace_id", id);
      if (error) {
        console.error(`account deletion: failed to clear ${table}`, id, error);
        return c.json({ error: "failed to close your account" }, 500);
      }
    }

    const { error } = await admin.from("workspaces").delete().eq("id", id);
    if (error) {
      console.error("account deletion: failed to delete empty workspace", id, error);
      return c.json({ error: "failed to close your account" }, 500);
    }
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    // Reachable if a new table gains a reference to `auth.users` without an
    // `on delete` clause — the exact failure `0016` was written to clear, and
    // one a schema change can reintroduce silently. Logged with the message
    // rather than swallowed, because the person on the other end has just been
    // told their account is gone and it is not.
    console.error("account deletion: deleteUser failed", deleteError);
    return c.json({ error: "failed to close your account" }, 500);
  }

  // Last, and best-effort, in that order for the same reason `documents.ts`
  // deletes its row before its object: a failure here leaves bytes nobody can
  // reach, while a failure the other way round leaves a row pointing at nothing.
  // The account is already gone by now, so there is nobody to report this to —
  // it goes to the log, where an operator with a retention obligation can find
  // the keys that were meant to go.
  for (const key of keys) {
    try {
      await getDocStore(c.env).delete(key);
    } catch (e) {
      console.error("account deletion: document store delete failed", key, e);
    }
  }

  return c.json({ ok: true });
});

export { account };
