import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { toEpochMs } from "../lib/dto";
import type { PendingInvitationDTO, IncomingInvitationDTO } from "../lib/dto";
import { callerWorkspaceId } from "../lib/workspace";
import { canSendEmail, sendEmail } from "../lib/email";
import { invitationEmail } from "../lib/emails/invitation";
import { joinedEmail } from "../lib/emails/joined";
import { appUrlOf, notify } from "../lib/emails/send";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { generateInviteToken, inviteUrl } from "../lib/invite-token";

const invitations = new Hono<AppEnv>();

const createInviteSchema = z.object({
  // Trimmed inside the schema, the way createWorkspaceSchema does it in
  // workspace.ts. Validating first and trimming after — which is what this did
  // — rejects "  a@b.com  " as malformed before the trim ever runs, so someone
  // pasting an address with a stray space is told their email is invalid.
  email: z.string().trim().email(),
  role: z.enum(["admin", "member", "viewer"]),
});

// GET /invitations — pending invites for the caller's active workspace (admin).
//
// Expired ones too, since 0090: an invitation whose link has run out, or that
// was made before invitations had links at all, is still somebody the admin
// meant to invite. It is listed with `needsResend` rather than dropped, so the
// way forward is one button instead of revoking and inviting again.
invitations.get("/invitations", async (c) => {
  const db = c.get("db");

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  // RLS returns rows only to admins of the workspace (or invitees by email);
  // scoping to workspace + pending keeps this to the admin's pending list.
  const { data, error } = await db
    .from("invitations")
    .select("id, email, role, created_at, expires_at, token_issued_at, invited_by")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load invitations" }, 500);

  // "Invited by Deniz · 2 days ago" (A3). `invited_by` points at auth.users,
  // which PostgREST cannot embed, so the names are a second read — of profiles
  // the caller shares a workspace with, which the inviter always is. A name
  // that does not come back (a deleted account) is null, never a guess.
  const inviterIds = [
    ...new Set((data ?? []).map((r) => r.invited_by as string | null).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string | null>();
  if (inviterIds.length > 0) {
    const { data: profiles } = await db.from("profiles").select("id, name").in("id", inviterIds);
    for (const p of profiles ?? []) names.set(p.id as string, (p.name as string | null) ?? null);
  }

  const now = Date.now();
  const result: PendingInvitationDTO[] = (data ?? []).map((r) => {
    const by = (r.invited_by as string | null) ?? null;
    return {
      id: r.id as string,
      email: r.email as string,
      role: r.role as string,
      createdAt: toEpochMs(r.created_at as string),
      needsResend: !r.token_issued_at || Date.parse(r.expires_at as string) <= now,
      invitedBy: by ? { id: by, name: names.get(by) ?? null } : null,
      expiresAt: r.expires_at ? toEpochMs(r.expires_at as string) : null,
    };
  });
  return c.json(result);
});

/**
 * How many invitation emails one workspace may send in a day, new and resent
 * together.
 *
 * An invitation is a Covan-branded email to any address, carrying a workspace
 * name and a person's name somebody chose, and any free account is the admin
 * of a workspace. Without a ceiling that is a mail relay. Fifty is more than a
 * team onboarding in a day needs and far less than spam does.
 *
 * Counted from `workspace_events` rather than from `invitations`: revoking one
 * deletes the row, so invite-revoke-invite would never add up, and the event
 * log keeps both kinds and has no delete for anybody.
 */
export const DAILY_INVITATIONS_PER_WORKSPACE = 50;

async function invitationsSentToday(
  db: Context<AppEnv>["var"]["db"],
  workspaceId: string,
): Promise<number | null> {
  const { count, error } = await db
    .from("workspace_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("action", ["invitation.created", "invitation.resent"])
    .gt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  return error ? null : (count ?? 0);
}

const OVER_THE_DAILY_CAP = {
  error:
    `This workspace has sent ${DAILY_INVITATIONS_PER_WORKSPACE} invitations today. ` +
    "Try again tomorrow.",
};

// POST /invitations — create an invite (admin only, enforced by RLS insert policy).
invitations.post("/invitations", async (c) => {
  // Asked before the body is even read, because the answer does not depend on
  // it. An admin's key may invite an admin, and the result is a second person
  // with their own session — access in somebody else's hands that revoking the
  // key does not reach. See `lib/api-key-rule.ts` for the rule this is one of.
  const refusal = refuseIfKeyAuthenticated(c, "invite people to a workspace");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const user = c.get("user");

  const parsed = createInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  const email = parsed.data.email.toLowerCase();

  // Re-inviting an existing member is not harmless: accept_invitation does
  // `on conflict do nothing` on the membership, but it still switches their
  // active workspace — so a mistyped address can pull a colleague out of
  // whatever they were working in.
  //
  // No FK links workspace_members to profiles (both reference auth.users
  // independently), so PostgREST cannot embed one through the other — this is
  // a plain two-step lookup rather than a single embedded select.
  //
  // ilike, not eq: profiles.email is copied verbatim from auth.users.email at
  // signup and never lowercased, so an exact eq would miss "Bob@Corp.com"
  // against a stored "bob@corp.com". The address itself is user input, so its
  // ILIKE metacharacters (%, _) are escaped first — this is the first
  // ilike/or/filter built from user input in this codebase, and it should
  // only ever narrow to an exact case-insensitive match, never pattern-match.
  const escapedEmail = email.replace(/[%_]/g, "\\$&");
  const { data: matchingProfile } = await db
    .from("profiles")
    .select("id")
    .ilike("email", escapedEmail)
    .maybeSingle();

  if (matchingProfile) {
    const { data: existingMembership } = await db
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", matchingProfile.id as string)
      .maybeSingle();

    if (existingMembership) {
      return c.json({ error: "They're already in this workspace." }, 409);
    }
  }

  const sentToday = await invitationsSentToday(db, workspaceId);
  if (sentToday === null) return c.json({ error: "could not check today's invitations" }, 500);
  if (sentToday >= DAILY_INVITATIONS_PER_WORKSPACE) return c.json(OVER_THE_DAILY_CAP, 429);

  // The token is minted here and kept nowhere but the email and this one
  // response: the database holds its hash (0090), so it cannot be shown again.
  const { token, tokenHash } = await generateInviteToken();

  const { data, error } = await db
    .from("invitations")
    .insert({
      workspace_id: workspaceId,
      email,
      role: parsed.data.role,
      invited_by: user.id,
      token_hash: tokenHash,
    })
    .select("id, email, role, created_at");

  if (error) {
    // Unique-pending index violation → already invited.
    if (error.code === "23505") {
      return c.json(
        { error: "That address already has a pending invitation. Resend it from the list below." },
        409,
      );
    }
    // RLS insert check failure surfaces as an error → treat as forbidden.
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }

  const row = data[0];
  const link = inviteUrl(appUrlOf(c), row.id as string, token);

  // Told, not created. The row above IS the invitation, so a failed email must
  // not roll anything back. What the caller gets is the truth about whether it
  // went, and the link either way: on an install with no mail configured the
  // admin passing it on is the only way the invitee ever receives it.
  const emailed = await notifyInvitee(c, {
    email,
    role: parsed.data.role,
    workspaceId,
    inviteUrl: link,
  });

  const result: PendingInvitationDTO = {
    id: row.id as string,
    email: row.email as string,
    role: row.role as string,
    createdAt: toEpochMs(row.created_at as string),
    emailed,
    inviteUrl: link,
    needsResend: false,
  };
  return c.json(result, 201);
});

// POST /invitations/:id/resend — a new link for a pending invitation (admin).
//
// For a link that ran out, one made before invitations had links (0090), or
// one that never arrived. The old link stops working: `reissue_invitation`
// replaces the stored hash, restarts the seven days and logs it.
invitations.post("/invitations/:id/resend", async (c) => {
  // The same reason creating one is refused: the link is a way into the
  // workspace for whoever holds it, and it outlives the key.
  const refusal = refuseIfKeyAuthenticated(c, "resend an invitation");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const id = c.req.param("id");

  // Counted against the invitation's own workspace, which a caller who may
  // resend it can read. Not found here is the same 404 as below.
  const { data: target } = await db
    .from("invitations")
    .select("workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (target) {
    const sentToday = await invitationsSentToday(db, target.workspace_id as string);
    if (sentToday === null) return c.json({ error: "could not check today's invitations" }, 500);
    if (sentToday >= DAILY_INVITATIONS_PER_WORKSPACE) return c.json(OVER_THE_DAILY_CAP, 429);
  }

  const { token, tokenHash } = await generateInviteToken();
  const { error: reissueError } = await db.rpc("reissue_invitation", {
    p_invite_id: id,
    p_token_hash: tokenHash,
  });
  if (reissueError) {
    // P0002 is both "no such invitation" and "not an admin of its workspace",
    // deliberately one answer. 22P02 is an id that is not a uuid.
    if (reissueError.code === "P0002" || reissueError.code === "22P02") {
      return c.json({ error: "invitation not found or not permitted" }, 404);
    }
    return c.json({ error: "failed to resend the invitation" }, 500);
  }

  const { data: row, error } = await db
    .from("invitations")
    .select("id, email, role, created_at, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) return c.json({ error: "failed to load the invitation" }, 500);

  const link = inviteUrl(appUrlOf(c), id, token);
  const emailed = await notifyInvitee(c, {
    email: row.email as string,
    role: row.role as string,
    workspaceId: row.workspace_id as string,
    inviteUrl: link,
  });

  const result: PendingInvitationDTO = {
    id,
    email: row.email as string,
    role: row.role as string,
    createdAt: toEpochMs(row.created_at as string),
    emailed,
    inviteUrl: link,
    needsResend: false,
  };
  return c.json(result);
});

/**
 * Best-effort. Returns whether the invitee was actually emailed.
 *
 * Every failure path answers false rather than throwing: an unset RESEND_API_KEY
 * (a supported self-hosted configuration), a Resend that refuses, a name lookup
 * that comes back empty. None of them is a reason to fail a request whose work
 * is already committed.
 */
async function notifyInvitee(
  c: Context<AppEnv>,
  invite: { email: string; role: string; workspaceId: string; inviteUrl: string },
): Promise<boolean> {
  if (!canSendEmail(c.env)) return false;

  try {
    const db = c.get("db");
    const user = c.get("user");

    const [{ data: ws }, { data: profile }] = await Promise.all([
      db.from("workspaces").select("name").eq("id", invite.workspaceId).maybeSingle(),
      db.from("profiles").select("name").eq("id", user.id).maybeSingle(),
    ]);

    // Falling back to the inviter's own email rather than to "Someone": a name
    // the recipient can recognise is the difference between an invitation and a
    // phishing attempt, and the address is the one thing we always have.
    const inviterName = (profile?.name as string | null) || user.email || "A teammate";

    const res = await sendEmail(
      invitationEmail({
        workspaceName: (ws?.name as string | null) || "a workspace",
        inviterName,
        role: invite.role,
        email: invite.email,
        inviteUrl: invite.inviteUrl,
      }),
      { fetchImpl: fetch.bind(globalThis), apiKey: c.env.RESEND_API_KEY, from: c.env.RESEND_FROM },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// DELETE /invitations/:id — revoke a pending invite (admin only).
invitations.delete("/invitations/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "revoke an invitation");
  if (refusal) return c.json(refusal, 403);

  const db = c.get("db");
  const id = c.req.param("id");

  const { data, error } = await db.from("invitations").delete().eq("id", id).select("id");

  if (error) return c.json({ error: "failed to revoke invitation" }, 500);
  if (!data || data.length === 0) {
    return c.json({ error: "invitation not found or not permitted" }, 404);
  }
  return c.json({ ok: true });
});

// GET /invitations/incoming — pending invites addressed to the caller's email.
//
// Through `incoming_invitations()` (0114) rather than a select on
// `invitations`. Two reasons, one old and one new.
//
// The old one: `invitations_select_admin_or_invitee` (0003) admits a row when
// the caller is an admin of the workspace OR the row is addressed to them, so
// a plain select answered "invitations you can see" when this route asks
// "invitations addressed to you", and an admin met their own outgoing
// invitations in the incoming banner. The function matches on the address on
// the caller's own account, lowercased as `invitations.email` always is, and
// on nothing else.
//
// The new one: the invitee is not a member yet, so the `workspaces(name)` the
// select used to embed was hidden by `workspaces`' own policy and the banner
// read "You've been invited to  as member". The function returns the
// workspace's name and the inviter's, and nothing else about either.
invitations.get("/invitations/incoming", async (c) => {
  const db = c.get("db");

  const { data, error } = await db.rpc("incoming_invitations");
  if (error) return c.json({ error: "failed to load invitations" }, 500);

  const rows = (data ?? []) as {
    id: string;
    workspace_id: string;
    workspace_name: string | null;
    inviter_name: string | null;
    role: string;
    created_at: string;
  }[];
  const result: IncomingInvitationDTO[] = rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name ?? "",
    inviterName: r.inviter_name ?? null,
    role: r.role,
    createdAt: toEpochMs(r.created_at),
  }));
  return c.json(result);
});

const acceptSchema = z.object({
  // From the invitation email's link, via `src/lib/invite-stash.ts`. Bounded
  // so a pasted essay is a 400 rather than a hash computed over it.
  token: z.string().min(1).max(200),
});

// POST /invitations/:id/accept — accept via SECURITY DEFINER RPC, with the
// token the invitation email carried (0090).
invitations.post("/invitations/:id/accept", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "accept an invitation");
  if (refusal) return c.json(refusal, 403);

  const parsed = acceptSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "open the link in your invitation email to accept it" }, 400);
  }

  const db = c.get("db");
  const id = c.req.param("id");

  // Read before accepting. `accept_invitation` consumes the row — afterwards it
  // is no longer pending, and being addressed to the caller is the only reason
  // row level security lets them see it at all.
  //
  // Guarded, because this read exists only to address a courtesy email. Accepting
  // an invitation is the one action in this file that grants somebody access, and
  // it must not become conditional on a lookup that nothing else needs.
  const invite = await Promise.resolve(
    db.from("invitations").select("invited_by, workspaces(name)").eq("id", id).maybeSingle(),
  )
    .then((r) => r.data)
    .catch(() => null);

  const { data, error } = await db.rpc("accept_invitation", {
    p_invite_id: id,
    p_token: parsed.data.token,
  });

  if (error) {
    return c.json({ error: error.message || "failed to accept invitation" }, 400);
  }

  await notifyInviter(c, invite);

  return c.json({ workspaceId: data as string });
});

/**
 * Tell the inviter their invitation was taken up.
 *
 * Best-effort throughout, and deliberately so: the membership exists whether or
 * not this note arrives, and a mail failure that propagated would report a join
 * that really happened as a failure to join. Every unknown — no invitation row,
 * no `invited_by`, a profile without an address — is a reason to send nothing
 * rather than to guess a recipient.
 */
async function notifyInviter(
  c: Context<AppEnv>,
  invite: { invited_by?: unknown; workspaces?: unknown } | null,
): Promise<void> {
  try {
    const joiner = c.get("user").email;
    const inviterId = invite?.invited_by as string | undefined;
    if (!joiner || !inviterId) return;

    const { data: inviter } = await c
      .get("db")
      .from("profiles")
      .select("name, email")
      .eq("id", inviterId)
      .maybeSingle();

    const inviterEmail = inviter?.email as string | undefined;
    if (!inviterEmail) return;

    // PostgREST answers an embedded one-to-one as an object and an embedded
    // list as an array, and which one you get depends on how it reads the
    // relationship rather than on anything visible here.
    const ws = invite?.workspaces as { name?: string } | { name?: string }[] | null;
    const workspaceName = (Array.isArray(ws) ? ws[0]?.name : ws?.name) || "your workspace";

    notify(
      c,
      joinedEmail({ inviterEmail, joinerEmail: joiner, workspaceName, appUrl: appUrlOf(c) }),
    );
  } catch {
    // The join succeeded. There is nothing here worth failing it for.
  }
}

export { invitations };
