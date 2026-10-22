/**
 * Who can reach an agent, and how far — the screen's half of 0104.
 *
 * The database decides (`agent_access_for` in supabase/migrations); every
 * answer here is read off the `myAccess` the API computed from it. What this
 * file is for is the same thing `roles.ts` is for: not offering a control the
 * server will refuse, and saying the levels the same way on every screen.
 *
 * Kept apart from `agents-store` on purpose. A test that mocks the store
 * replaces the whole module, and a helper that lived there would vanish with
 * it — taking every component that asks "can I edit this?" down too.
 */

export const AGENT_ACCESS = ["use", "edit", "manage"] as const;

export type AgentAccess = (typeof AGENT_ACCESS)[number];

export type AgentShare = { userId: string; access: AgentAccess };

/**
 * What `PUT /agents/:id/sharing` takes and what an agent carries.
 *
 * Only me is `null` and no shares; specific people is `null` and a list; the
 * whole workspace is a level, with shares that can only raise somebody above it.
 */
export type AgentSharing = { workspaceAccess: AgentAccess | null; shares: AgentShare[] };

/** One name per level, on every screen that shows one. */
export const ACCESS_LABEL: Record<AgentAccess, string> = {
  use: "Can use",
  edit: "Can edit",
  manage: "Full access",
};

/** What each level adds, for the picker. Cumulative, like the levels. */
export const ACCESS_HINT: Record<AgentAccess, string> = {
  use: "Chat with it. Its settings are read-only.",
  edit: "Also change its persona, model and knowledge.",
  manage: "Also share it, and delete it.",
};

/** 0 for no access, then 1–3. Mirrors `agent_access_rank`. */
export function accessRank(access: AgentAccess | null | undefined): number {
  return access ? AGENT_ACCESS.indexOf(access) + 1 : 0;
}

/** Persona, model, tuning, knowledge, tool grants. */
export function canEditAgent(agent: { myAccess: AgentAccess }): boolean {
  return accessRank(agent.myAccess) >= 2;
}

/** Sharing, deleting, restoring. */
export function canManageAgent(agent: { myAccess: AgentAccess }): boolean {
  return agent.myAccess === "manage";
}

/**
 * A viewer is capped at Can use whatever they were given. The grant is kept —
 * promoting them is what turns it on — so the row says why it is not working
 * yet rather than refusing to store it.
 */
export function cappedByRole(role: string | null | undefined, access: AgentAccess): boolean {
  return role === "viewer" && access !== "use";
}

export type SharingMode = "only" | "people" | "workspace";

export function sharingMode(sharing: AgentSharing): SharingMode {
  if (sharing.workspaceAccess) return "workspace";
  return sharing.shares.length > 0 ? "people" : "only";
}

/**
 * The body to send for a choice in the dialog.
 *
 * Switching to Only me keeps the people in the dialog's own state, so changing
 * your mind back does not mean adding them again — but it sends none of them,
 * because Only me with a list is not Only me.
 */
export function sharingFor(
  mode: SharingMode,
  workspaceLevel: AgentAccess,
  shares: AgentShare[],
): AgentSharing {
  if (mode === "only") return { workspaceAccess: null, shares: [] };
  if (mode === "people") return { workspaceAccess: null, shares };
  return { workspaceAccess: workspaceLevel, shares };
}

/**
 * The line that says who an agent is shared with, as the settings page and the
 * gallery card both put it.
 *
 * Only the owner is "Only you" to the owner and "Only the owner" to an admin,
 * who can see it without being on any list.
 */
export function sharingSummary(
  agent: AgentSharing & { createdBy: string | null },
  myId: string | undefined,
): { mode: SharingMode; label: string } {
  const mode = sharingMode(agent);
  if (mode === "workspace") {
    return { mode, label: `Everyone · ${ACCESS_LABEL[agent.workspaceAccess!]}` };
  }
  if (mode === "people") {
    const n = agent.shares.length;
    return { mode, label: `${n} ${n === 1 ? "person" : "people"}` };
  }
  return {
    mode,
    label: agent.createdBy && agent.createdBy === myId ? "Only you" : "Only the owner",
  };
}

/**
 * The three choices offered while an agent is being made. Specific people is
 * not one of them: there is nobody to name until the agent exists, and the
 * full dialog is one click away once it does.
 */
export const NEW_AGENT_SHARING = ["only", "use", "edit"] as const;

export type NewAgentSharing = (typeof NEW_AGENT_SHARING)[number];

export const NEW_AGENT_SHARING_LABEL: Record<NewAgentSharing, string> = {
  only: "Only me",
  use: `Whole workspace · ${ACCESS_LABEL.use}`,
  edit: `Whole workspace · ${ACCESS_LABEL.edit}`,
};

export function newAgentSharing(choice: NewAgentSharing): AgentSharing {
  return { workspaceAccess: choice === "only" ? null : choice, shares: [] };
}

/** What the chip beside the tabs says about who else can use the agent. */
export function sharingWords(agent: AgentSharing): string {
  const mode = sharingMode(agent);
  if (mode === "workspace") return "Shared with team";
  if (mode === "people") {
    const n = agent.shares.length;
    return `Shared with ${n} ${n === 1 ? "person" : "people"}`;
  }
  return "Private";
}
