import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { entitlementsFor } from "../lib/entitlements";

/**
 * Attaches the request's entitlements to the context, so routes ask
 * `c.get("entitlements")` and never reach for an implementation directly.
 *
 * Runs after `authMiddleware` — quota is per user, and there is no user before
 * the token is validated.
 */
export const entitlementsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("entitlements", entitlementsFor(c.env));
  await next();
};
