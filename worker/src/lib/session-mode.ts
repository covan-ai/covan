/**
 * A session is in brainstorm mode when either the session itself is a brainstorm
 * session OR the agent is configured for brainstorm. The session kind lets a
 * normal agent facilitate a brainstorm without changing the agent's own setting.
 */
export function effectiveMode(
  session: { kind?: string | null },
  agent: { mode?: string | null },
): "normal" | "brainstorm" {
  return session.kind === "brainstorm" || agent.mode === "brainstorm" ? "brainstorm" : "normal";
}
