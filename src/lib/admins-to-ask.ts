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
  locale: string = "en-GB",
): string | null {
  const names = members
    .filter((m) => isAdminRole(m.role) && m.id !== selfId)
    .map((m) => m.name?.trim() || m.email || null)
    .filter((n): n is string => !!n);
  if (names.length === 0) return null;
  return new Intl.ListFormat(locale, { type: "disjunction" }).format(names);
}
