/**
 * A write the database refused because of who is asking.
 *
 * Row level security answers an INSERT it does not allow with SQLSTATE 42501
 * ("new row violates row-level security policy") — unlike an UPDATE or DELETE,
 * which it answers with zero rows. A route that reads every insert error as
 * its own failure turns that into a 500: "something broke" to a person who was
 * simply not allowed, and an error in the server's log for nothing. The routes
 * that insert through the caller's client ask this first and answer 403, in a
 * sentence of their own.
 */
export function refusedByPolicy(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "42501";
}
