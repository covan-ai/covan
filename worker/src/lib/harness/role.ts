import type { ToolContext } from "./registry";

/**
 * Whether the person a turn runs for may change things in this workspace
 * through a connected service: an admin or a member, not a viewer.
 *
 * A viewer can chat, and an agent's tools ran for them as for anybody — so a
 * viewer could have an agent send mail, file a ticket or delete a row through
 * a connection, and approve the card for it themselves. Reading stays open to
 * them; anything that changes something does not.
 *
 * Asked of `workspace_members` by `ctx.userId`, which the route resolved from
 * the request (or, on a scheduled run, is the routine's owner) — never of
 * anything the model wrote. Asked only when a write is about to happen, so a
 * turn that only reads pays nothing for it. A read that fails is "no": a
 * write refused for want of an answer is a sentence the model can repeat; a
 * write let through is not undone.
 */
export async function mayChangeThings(ctx: ToolContext): Promise<boolean> {
  try {
    const { data, error } = await ctx.db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", ctx.workspaceId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error || !data) return false;
    return data.role === "admin" || data.role === "member";
  } catch {
    return false;
  }
}

/** What the model is told when a viewer's turn reaches for a write. */
export const VIEWERS_READ_ONLY =
  "the person you are working for is a viewer in this workspace, and viewers cannot change " +
  "anything through a connected service — only read. Say so plainly and offer what can be " +
  "done by reading; do not retry this or look for another way to make the change.";
