import { isAdminRole } from "@/lib/roles";

/**
 * Who can add credits, by name, for somebody who cannot.
 *
 * Names first, then addresses, and the caller left out — an admin is never
 * told to ask themselves. Null when nobody in `members` is an admin, which
 * the database does not allow but a stale `me` can still briefly say.
 */
export function adminsToAsk(
  members: { id: string; name: string | null; email: string | null; role: string }[],
  selfId: string | undefined,
): string | null {
  const names = members
    .filter((m) => isAdminRole(m.role) && m.id !== selfId)
    .map((m) => m.name?.trim() || m.email || null)
    .filter((n): n is string => !!n);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
