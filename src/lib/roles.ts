/**
 * What each role in a workspace may do, on the screen's side of the boundary.
 *
 * The database is the boundary — `is_workspace_admin` and
 * `can_write_in_workspace` in supabase/migrations decide what actually
 * happens, and every write goes through them whatever this file says. What
 * this file is for is the interface not offering a control the database will
 * refuse, which is a bug of its own kind: a button that answers 403 tells
 * somebody they did something wrong when what they did was press the only
 * thing on the screen.
 */

export const WORKSPACE_ROLES = ["admin", "member", "viewer"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Mirrors `can_write_in_workspace()` from `0021`, including its bias: anything
 * that is not explicitly read-only may write. A role added to the database and
 * not to this file therefore behaves as a member here rather than being
 * silently locked out of controls with nothing to explain why.
 */
export function canWriteAsRole(role: string | null | undefined): boolean {
  return Boolean(role) && role !== "viewer";
}

/** Mirrors `is_workspace_admin()`. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

/**
 * One line each, for the role picker. These are the promises the policies
 * keep — if one of them stops being true, the policy is what changed.
 */
export const ROLE_SUMMARY: Record<WorkspaceRole, string> = {
  admin: "Runs the workspace: people, roles and settings.",
  member: "Builds: agents, knowledge and documents.",
  viewer: "Uses the agents. Changes none of them.",
};
