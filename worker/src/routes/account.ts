import { Hono } from "hono";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { getDocStore } from "../lib/docstore";
import { accountClosedEmail } from "../lib/emails/closed";
import { notify } from "../lib/emails/send";
import { connectedAccountsIn, revokeConnectedAccounts } from "../lib/composio/revoke";
import { releaseHeldConnections } from "../lib/connections/release";
import { deleteProfile } from "../lib/browser/profiles";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { avatarKeyFromUrl } from "../lib/avatars";
import { chunked, readAllPages } from "../lib/batch";
import { storedKeysOf } from "../lib/document-text";

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
 * done by hand. Only one stored object belongs to a *person* — an uploaded
 * profile photo, whose key is in `profiles.avatar_url` — and the rest are
 * documents: `documents.r2_key` hangs off a bundle, which hangs off a
 * workspace. But this route deletes workspaces too, and a workspace
 * cascade takes the rows that name the keys while leaving the bytes. For an
 * ordinary delete `documents.ts` calls that an acceptable storage cost. For
 * erasure it is not a cost, it is the files still being there. So the keys are
 * collected before the rows go, exactly as `docs/team.md` warns an operator to
 * do, because afterwards there is nothing left to enumerate them by.
 */
const account = new Hono<AppEnv>();

/** One row of `account_closure_plan()` (0091): counted in SQL, not paged. */
type PlanRow = {
  workspace_id: string;
  role: string;
  other_members: number;
  other_admins: number;
};

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
export function planWorkspaces(rows: PlanRow[]): { blocked: string[]; deletable: string[] } {
  const blocked: string[] = [];
  const deletable: string[] = [];

  for (const row of rows) {
    // PostgREST hands a bigint back as a number or a string depending on its
    // size; either way it is a count, and only "none" and "some" matter.
    const others = Number(row.other_members);
    const otherAdmins = Number(row.other_admins);
    if (others === 0) {
      deletable.push(row.workspace_id);
      continue;
    }
    if (row.role === "admin" && otherAdmins === 0) blocked.push(row.workspace_id);
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

  // In hundreds and page by page (`lib/batch.ts`): one list of every bundle
  // was a URL the gateway refused past a couple of hundred, and one read of
  // every document stopped at a thousand without saying so. Either way the
  // files of an account with that much in it outlived the account.
  const keys: string[] = [];
  for (const ids of chunked(bundleIds)) {
    const docs = await readAllPages<{ r2_key: string | null }>((from, to) =>
      admin.from("documents").select("r2_key").in("bundle_id", ids).order("id").range(from, to),
    );
    if (docs === null) {
      console.error("account deletion: could not list documents to clean up");
      continue;
    }
    for (const d of docs) if (d.r2_key) keys.push(...storedKeysOf(d.r2_key));
  }
  return keys;
}

// DELETE /account — close your own account, and nothing else's.
account.delete("/account", async (c) => {
  // The heaviest member of the family in `lib/api-key-rule.ts`, which is where
  // the reasoning lives: a leaked key that can close the account it came from
  // destroys the evidence and the account in one call, and no revocation
  // afterwards can undo it.
  const refusal = refuseIfKeyAuthenticated(c, "close an account");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  // Counted in the database (0091), not read row by row and counted here.
  // PostgREST caps a read at a thousand rows without saying so, and a survey
  // of every member of every workspace somebody is in was cut short exactly
  // there: a workspace whose members fell off the end looked empty, and was
  // deleted with them in it. Runs as the caller, so the counts are of the
  // fellow members their own policies show them — every member of a workspace
  // they are in.
  const { data: plan, error: planError } = await db.rpc("account_closure_plan");
  if (planError) return c.json({ error: "failed to check your workspaces" }, 500);

  const { blocked, deletable } = planWorkspaces((plan ?? []) as PlanRow[]);

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

  // The one stored object that does belong to a person: an uploaded photo
  // (`routes/avatars.ts`). The profile row goes with `auth.users` below, and
  // with it the only record of the key, so it is read now and joins the list
  // the store deletes at the end. Through the caller's own client, because it
  // is their own row. A provider's photo is not ours, and neither is a
  // co-member's path written into this row by hand; `avatarKeyFromUrl` answers
  // null for both; a failed read costs a photo nobody can reach, which is
  // the same judgement the document listing makes.
  const { data: ownProfile, error: ownProfileError } = await db
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  if (ownProfileError) {
    console.error(
      "account deletion: could not read the profile photo to clean up",
      ownProfileError,
    );
  }
  const avatar = avatarKeyFromUrl(
    (ownProfile?.avatar_url as string | null | undefined) ?? null,
    user.id,
  );
  if (avatar) keys.push(avatar);

  // The same ordering problem as the object keys, with a sharper consequence.
  // `tool_connections.workspace_id` cascades (0059) and a cascade runs no code,
  // so a workspace deleted here takes its Composio rows with it and leaves the
  // OAuth grants they stood for live at the provider — a mailbox still being
  // read, attached to an account id nothing in this product can show any more.
  // Collected before the delete, because afterwards there is nothing left to
  // enumerate them by. See `lib/composio/revoke.ts`.
  const connectedAccounts = await connectedAccountsIn(admin, deletable);

  /**
   * The browser profile, read before the cascade can take the row with it.
   *
   * `browser_profiles.user_id` cascades from `auth.users`, so
   * `admin.auth.admin.deleteUser` below drops this row — and a cascade runs no
   * code, so browser-use would keep a jar of live session cookies that nothing
   * left in this database can name. Worse than the Composio case above,
   * because those are revocable grants and this is a bag of cookies for sites
   * the person is still signed into.
   *
   * Collected now for the same reason the object keys and the connected
   * accounts are: afterwards there is nothing left to enumerate it by.
   */
  const { data: profileRow } = await admin
    .from("browser_profiles")
    .select("provider_profile_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const providerProfileId =
    typeof profileRow?.provider_profile_id === "string" ? profileRow.provider_profile_id : null;

  // Handed back before the rows go, and best-effort: a grant Composio refuses
  // to revoke is logged and the account still closes, because refusing to close
  // an account over a third party's 500 is the worse outcome — the same
  // judgement the document-store delete below already makes.
  await revokeConnectedAccounts(c.env, connectedAccounts);

  // The same for the Drive and Notion sources this person connected: revoked
  // at the provider, and in the workspaces that stay, the token cleared and
  // the source paused for somebody to reconnect. See `lib/connections/release.ts`.
  await releaseHeldConnections(c.env, admin, user.id, deletable);

  /**
   * Best-effort, and for the same judgement the line above makes: refusing to
   * close an account over a third party's 500 is the worse outcome. Logged
   * with the status rather than the body, because the body would name the
   * profile id — which is the one thing 0077 withholds from every client role.
   */
  if (providerProfileId) {
    const forgotten = await deleteProfile(c.env, providerProfileId);
    if (forgotten.kind === "error") {
      console.error(
        "closing an account but could not delete its browser profile",
        forgotten.status,
      );
    }
  }

  // Deleted before the user, and one at a time. Before, because the trigger
  // refuses the membership row while the workspace is still standing, and the
  // membership row is what the user's cascade has to remove. One at a time
  // because a failure part-way through should leave the rest of the account
  // intact and the caller told, rather than half a person in the database.
  for (const id of deletable) {
    // One statement per workspace, and it was three until 0035. `chat_sessions.
    // workspace_id` and `ideas.workspace_id` were plain references with no
    // delete rule, so this loop cleared both tables first — as the operator
    // procedure in `docs/team.md` and two RLS tests separately did. 0035 makes
    // both cascade and all four copies of that paragraph are gone with it.
    //
    // A failure here still leaves the rest of the account intact rather than
    // half a person in the database, which is why the loop is one workspace at
    // a time rather than one `in (…)` delete.
    //
    // Conditional, in the same statement (0091): deleted only if nobody but
    // this person is a member when it runs. The plan above is a moment old,
    // and a workspace somebody joined since is not this person's to delete.
    const { data: gone, error } = await admin.rpc("delete_workspace_if_sole_member", {
      p_workspace_id: id,
      p_user_id: user.id,
    });
    if (error) {
      console.error("account deletion: failed to delete empty workspace", id, error);
      return c.json({ error: "failed to close your account" }, 500);
    }
    if (gone !== true) {
      return c.json(
        { error: "somebody joined one of your workspaces while it was closing — try again" },
        409,
      );
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

  // After the deletion succeeded, never before it. A receipt for an erasure that
  // did not happen is worse than no receipt: it tells somebody their data is
  // gone while it is still there. The address comes from the token rather than
  // from the database, which is what makes it still readable now that the
  // profile row is not.
  if (user.email) {
    notify(c, accountClosedEmail({ email: user.email }));
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
