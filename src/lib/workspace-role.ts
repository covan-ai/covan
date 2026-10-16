import { useQuery } from "@tanstack/react-query";
import { api, type Me } from "@/lib/api-client";
import { canWriteAsRole, isAdminRole } from "@/lib/roles";

/**
 * The caller's role in the active workspace, read from `me`.
 *
 * Both answers are false while `me` loads. That is the safe default for the
 * question most callers ask — whether to fetch a section at all — because a
 * request that 403s before the role is known is worse than a section that
 * appears a moment late. A caller that would rather not watch a form lock and
 * unlock on every cold load opts out of it explicitly, where it can say why
 * (the workspace settings page does).
 */
export function useWorkspaceRole(): {
  me: Me | undefined;
  role: string | undefined;
  isAdmin: boolean;
  canWrite: boolean;
} {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const role = me?.members.find((m) => m.id === me.user.id)?.role;
  return { me: me ?? undefined, role, isAdmin: isAdminRole(role), canWrite: canWriteAsRole(role) };
}
