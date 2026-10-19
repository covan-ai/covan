import type { SupabaseClient } from "@supabase/supabase-js";
import { getToolkit, proxyRequest, type ComposioEnv, type ComposioOptions } from "./client";

/**
 * Whether the credential a connection was made with actually works.
 *
 * Measured 2026-10-05 (covan#258): Composio marks a connected account
 * `ACTIVE` on a deliberately wrong API key — it never tries the key. So the
 * card said connected, a chat starter offered the application, and the first
 * the person heard of it was the provider's own 401 in front of whoever asked
 * an agent to do something, rather than whoever typed the key.
 *
 * One read, right after the account goes active: the request the catalogue
 * itself names for "who is this credential" (`get_current_user_endpoint`),
 * through Composio's proxy so the credential never comes here. 0072 decided
 * what the answer may do, and this follows it to the letter:
 *
 * - A **401 or 403** from the provider writes `verify_error`. The row stays
 *   `active` — a warning, never a failure: a check with false negatives must
 *   not close a connection that works.
 * - A **2xx** writes `verified_at` and clears any earlier warning.
 * - **Anything else writes nothing** — no endpoint in the catalogue, a method
 *   other than GET (a "who am I" that is a POST is not obviously a read), the
 *   proxy refusing, a 404 from a path the catalogue got wrong, a 5xx. Not
 *   knowing is said by `verified_at` staying null, which is what it already
 *   says for every row made before this check existed.
 *
 * Never throws: it runs on the path that has just told the person their
 * application is connected.
 */
export type VerifyOutcome = "verified" | "refused" | "unknown";

/** How much of the provider's own sentence the card may show. */
const MAX_REASON_CHARS = 240;

export async function verifyConnection(
  env: ComposioEnv,
  db: SupabaseClient,
  row: { id: string; toolkitSlug: string; connectedAccountId: string },
  opts?: ComposioOptions,
): Promise<VerifyOutcome> {
  try {
    const found = await getToolkit(env, row.toolkitSlug, opts);
    if (found.kind === "error") return "unknown";
    const { toolkit } = found;
    const endpoint = toolkit.currentUserEndpoint ?? "";
    if (!endpoint || (toolkit.currentUserMethod ?? "GET") !== "GET") return "unknown";

    const answer = await proxyRequest(
      env,
      { connectedAccountId: row.connectedAccountId, endpoint, method: "GET" },
      opts,
    );
    if (answer.kind === "error") return "unknown";

    if (answer.status === 401 || answer.status === 403) {
      const said = providerSentence(answer.data);
      const { error } = await db
        .from("tool_connections")
        .update({
          verified_at: null,
          verify_error: said
            ? `${toolkit.name} refused this credential: ${said}`
            : `${toolkit.name} refused this credential (HTTP ${answer.status}).`,
        })
        .eq("id", row.id);
      if (error) console.error("could not record a refused credential", error);
      return "refused";
    }
    if (answer.status >= 200 && answer.status < 300) {
      const { error } = await db
        .from("tool_connections")
        .update({ verified_at: new Date().toISOString(), verify_error: null })
        .eq("id", row.id);
      if (error) console.error("could not record a verified credential", error);
      return "verified";
    }
    return "unknown";
  } catch (err) {
    console.error("could not check a connection's credential", err);
    return "unknown";
  }
}

/**
 * The provider's own words, from the shapes refusals usually take:
 * `{message}`, `{error: "…"}`, `{error: {message}}`, `{detail}`. Empty when
 * none of them is there, rather than a guess at what it meant.
 */
function providerSentence(data: unknown): string {
  const record = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const top = record(data);
  if (!top) return typeof data === "string" ? data.slice(0, MAX_REASON_CHARS) : "";
  const nested = record(top.error);
  const said = [
    top.message,
    top.detail,
    typeof top.error === "string" ? top.error : null,
    nested?.message,
  ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return said ? said.trim().slice(0, MAX_REASON_CHARS) : "";
}
