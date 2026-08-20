import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { authClient, userClient } from "../lib/supabase";

/**
 * Validates the `Authorization: Bearer <token>` header against Supabase auth,
 * then attaches:
 *   - c.set("user", <the authenticated user>)
 *   - c.set("db", <a request-scoped Supabase client carrying that token>)
 *
 * The `db` client is what downstream routes must use for data access — it
 * ensures Postgres RLS (`auth.uid()`) resolves to the caller, so tenant
 * isolation is enforced by the database, not by application code.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;

  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { data, error } = await authClient(c.env).auth.getUser(token);

  if (error || !data?.user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", data.user);
  c.set("db", userClient(c.env, token));

  await next();
};
