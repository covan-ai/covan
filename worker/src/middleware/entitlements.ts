import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { entitlementsFor } from "../lib/entitlements";

/**
 * Attaches the request's entitlements to the context, so routes ask
 * `c.get("entitlements")` and never reach for an implementation directly.
 *
 * Runs after `authMiddleware`: a route resolves the workspace it charges from
 * the caller, and there is no caller before the token is validated.
 */
export const entitlementsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("entitlements", entitlementsFor(c.env));
  await next();
};
