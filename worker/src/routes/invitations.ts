import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { toEpochMs } from "../lib/dto";
import type { PendingInvitationDTO, IncomingInvitationDTO } from "../lib/dto";
import { getActiveWorkspaceId } from "../lib/workspace";
import { canSendEmail, sendEmail } from "../lib/email";

const invitations = new Hono<AppEnv>();

/**
 * The invitation email.
 *
 * Deliberately not a link that accepts anything. Acceptance runs through
 * `accept_invitation`, which matches the invitation's email against the
 * caller's verified JWT email — so the address IS the credential, and a token
 * in a URL would be a second, weaker one guarding the same door. What the
 * recipient needs to know is which address to use; that is what this says.
 *
 * Plain text, no HTML part: it is four sentences, and an HTML mail that renders
 * as a blank card in a client that strips styles is worse than no HTML at all.
 */
function invitationEmail(args: {
  workspaceName: string;
  inviterName: string;
  role: string;
  email: string;
  appUrl: string;
}) {
  const asRole = args.role === "admin" ? "an admin" : "a member";
  return {
    to: args.email,
    subject: `${args.inviterName} invited you to ${args.workspaceName} on Covan`,
    // Hard-wrapped, and every interpolated value sits on a line of its own —
    // an address or a workspace name in the middle of a sentence pushes the
    // wrap around and turns a tidy paragraph into a ragged one for exactly the
    // people whose names are longest.
    text: [
      `${args.inviterName} invited you to join ${args.workspaceName} on Covan,`,
      `as ${asRole}.`,
      "",
      "Covan is where a team keeps its AI agents: the agents and the knowledge",
      "they read are shared, and your own conversations stay yours.",
      "",
      "To accept, sign in and the invitation will be waiting:",
      "",
      `  ${args.appUrl}`,
      "",
      "Sign in with the address this was sent to:",
      "",
      `  ${args.email}`,
      "",
      "If you do not have an account yet, sign up with that same address — it is",
      "what the invitation is matched to, so a different one will not find it.",
      "",
      "If you were not expecting this, you can ignore it. Nothing happens until",
      "you accept.",
    ].join("\n"),
  };
}

const createInviteSchema = z.object({
  // Trimmed inside the schema, the way createWorkspaceSchema does it in
  // workspace.ts. Validating first and trimming after — which is what this did
  // — rejects "  a@b.com  " as malformed before the trim ever runs, so someone
  // pasting an address with a stray space is told their email is invalid.
  email: z.string().trim().email(),
  role: z.enum(["admin", "member", "viewer"]),
});

// GET /invitations — pending invites for the caller's active workspace (admin).
invitations.get("/invitations", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const workspaceId = await getActiveWorkspaceId(db, user.id);
  if (!workspaceId) return c.json({ error: "no workspace found for user" }, 404);

  // RLS returns rows only to admins of the workspace (or invitees by email);
  // scoping to workspace + pending keeps this to the admin's pending list.
  const { data, error } = await db
    .from("invitations")
    .select("id, email, role, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load invitations" }, 500);

  const result: PendingInvitationDTO[] = (data ?? []).map((r) => ({
    id: r.id as string,
    email: r.email as string,
    role: r.role as string,
    createdAt: toEpochMs(r.created_at as string),
  }));
  return c.json(result);
});

// POST /invitations — create an invite (admin only, enforced by RLS insert policy).
invitations.post("/invitations", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  const parsed = createInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const workspaceId = await getActiveWorkspaceId(db, user.id);
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
      return c.json({ error: "they're already in this workspace" }, 409);
    }
  }

  const { data, error } = await db
    .from("invitations")
    .insert({
      workspace_id: workspaceId,
      email,
      role: parsed.data.role,
      invited_by: user.id,
    })
    .select("id, email, role, created_at");

  if (error) {
    // Unique-pending index violation → already invited.
    if (error.code === "23505") {
      return c.json({ error: "that email already has a pending invitation" }, 409);
    }
    // RLS insert check failure surfaces as an error → treat as forbidden.
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "only workspace admins can invite members" }, 403);
  }

  const row = data[0];

  // Told, not created. The row above IS the invitation — it is what
  // /invitations/incoming reads and what accept_invitation consumes — so the
  // email is a courtesy and its failure must not roll anything back. What the
  // caller gets is the truth about whether it went, which the dialog then says
  // instead of the "Invite sent" it used to say unconditionally.
  const emailed = await notifyInvitee(c, {
    email,
    role: parsed.data.role,
    workspaceId,
  });

  const result: PendingInvitationDTO = {
    id: row.id as string,
    email: row.email as string,
    role: row.role as string,
    createdAt: toEpochMs(row.created_at as string),
    emailed,
  };
  return c.json(result, 201);
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
  invite: { email: string; role: string; workspaceId: string },
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
        // ALLOWED_ORIGIN is a comma-separated list — a deployment reachable at
        // more than one origin sets several. The first is the canonical one,
        // and putting the raw variable in the mail would send somebody a URL
        // with a comma in it.
        appUrl: (c.env.ALLOWED_ORIGIN ?? "").split(",")[0].trim(),
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
invitations.get("/invitations/incoming", async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  // The address filter is this query's job, not the policy's.
  //
  // `invitations_select_admin_or_invitee` (0003) admits a row when the caller
  // is an admin of the workspace OR the row is addressed to them. That is the
  // right policy — an admin has to be able to read the pending invitations the
  // Team page lists. It is the wrong scope for this route, which used to lean
  // on it entirely and so answered "invitations you can see" when it was asked
  // "invitations addressed to you". An admin therefore met their own outgoing
  // invitations in the incoming banner: "You've been invited to <your own
  // workspace> as <the role you just granted somebody else>". Accepting one
  // could never work either, because `accept_invitation()` compares the
  // address against the caller's own — so the banner offered an action that
  // was guaranteed to be refused.
  //
  // Exactly the mistake 0022 spent a header on: a policy answers "may this
  // person see this row", which stopped being the same question as "is this
  // row theirs" the moment admins were added to the `or`. The policy is left
  // alone; the query says which rows it means.
  //
  // `.eq` rather than the `ilike` the create path needs: `invitations.email`
  // is lowercased on insert, while `profiles.email` is copied verbatim from
  // auth and is not. Lowercasing the caller's own address matches what the
  // policy already does with `lower(auth.jwt() ->> 'email')`, and an absent
  // one narrows to nothing rather than widening to everything.
  const callerEmail = (user.email ?? "").toLowerCase();

  const { data, error } = await db
    .from("invitations")
    .select("id, workspace_id, role, created_at, workspaces(name)")
    .eq("status", "pending")
    .eq("email", callerEmail)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: "failed to load invitations" }, 500);

  const result: IncomingInvitationDTO[] = (data ?? []).map((r) => {
    const ws = r.workspaces as { name: string } | { name: string }[] | null;
    const name = Array.isArray(ws) ? (ws[0]?.name ?? "") : (ws?.name ?? "");
    return {
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      workspaceName: name,
      role: r.role as string,
      createdAt: toEpochMs(r.created_at as string),
    };
  });
  return c.json(result);
});

// POST /invitations/:id/accept — accept via SECURITY DEFINER RPC.
invitations.post("/invitations/:id/accept", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data, error } = await db.rpc("accept_invitation", { p_invite_id: id });

  if (error) {
    return c.json({ error: error.message || "failed to accept invitation" }, 400);
  }
  return c.json({ workspaceId: data as string });
});

export { invitations };
