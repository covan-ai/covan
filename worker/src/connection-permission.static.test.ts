import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the question `/connections/:id/…` has to ask twice.
 *
 * Seeing a connection and acting on one are different permissions.
 * `connections_select_member` admits every member of the workspace, viewers
 * included, so `loadForCaller` returning a row means membership and nothing
 * more. `connections_update_owner_or_admin` (0057) is what answers the second
 * question, and `mayChangeConnection` is the only thing in the file that asks
 * it.
 *
 * Reaching the stored grant is `withSecret`, and `tokenFor`, which wraps it.
 * Both use the service role, because 0043 withholds `secret_ciphertext` from
 * every client role — so past that call no policy is consulted again, and
 * whatever the handler does with the token it does with the grant holder's
 * authority rather than the caller's.
 *
 * A handler that forgets to ask therefore does not fail. It answers 200, with
 * somebody else's Drive in the body. `GET /connections/:id/folders` did exactly
 * that — finding 5 of the 2026-10-08 audit — and it read as correct in review
 * precisely because the load in front of it goes through the caller's own
 * client: the handler does ask the database something, just not this.
 *
 * So the pairing is pinned. A handler may reach the grant without asking only
 * by being written into READ_ONLY_BY_DESIGN with the reason, which is the whole
 * mechanism: the exemption has to be argued for by somebody rather than noticed
 * by nobody.
 */
const ROUTE = join(process.cwd(), "src", "routes", "connections.ts");

/** The names that reach a connection's stored credential. */
const REACHES_THE_GRANT = ["withSecret", "tokenFor"];

/** The only thing in the file that asks whether this caller may. */
const ASKS_FIRST = "mayChangeConnection";

/**
 * Handlers that reach the grant without asking, and why that is sound.
 *
 * Empty is the healthy state, and it is currently empty. An entry is a claim
 * that a handler can hand a caller the grant holder's authority safely, and it
 * should read like one — what bounds the reach, and who checked.
 */
const READ_ONLY_BY_DESIGN: Record<string, string> = {};

type Handler = { label: string; body: string };

/**
 * Every route handler in the file, labelled `method path`.
 *
 * Both routers are registered in one file and a handler always closes on a
 * `});` in the first column, so the split needs no parser. The guard below
 * checks the count, because a split that silently found nothing would make
 * every assertion here pass.
 */
function handlers(): Handler[] {
  const lines = readFileSync(ROUTE, "utf8").split("\n");
  const out: Handler[] = [];
  let open: Handler | null = null;

  for (const line of lines) {
    const start = /^connections(?:Public)?\.(get|post|patch|put|delete)\("([^"]+)"/.exec(line);
    if (start) {
      open = { label: `${start[1]} ${start[2]}`, body: "" };
      continue;
    }
    if (!open) continue;
    if (line === "});") {
      out.push(open);
      open = null;
      continue;
    }
    open.body += `${line}\n`;
  }

  return out;
}

const routes = handlers();

function reachesTheGrant(h: Handler): boolean {
  return REACHES_THE_GRANT.some((name) => h.body.includes(`${name}(`));
}

describe("a handler that reaches a connection's grant", () => {
  it("was found by the split at all", () => {
    // Without this, a renamed router or a reformatted file would leave the
    // assertions below running over an empty list and reporting success.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.map((h) => h.label)).toContain("get /connections/:id/folders");
    expect(routes.map((h) => h.label)).toContain("post /connections/:id/sync");
    expect(routes.filter(reachesTheGrant).length).toBeGreaterThan(1);
  });

  it("asks the database first, every time", () => {
    const unasked = routes
      .filter((h) => reachesTheGrant(h) && !h.body.includes(ASKS_FIRST))
      .map((h) => h.label)
      .filter((label) => !(label in READ_ONLY_BY_DESIGN));

    expect(
      unasked,
      `these reach the stored grant through ${REACHES_THE_GRANT.join(" or ")}, which ` +
        `uses the service role and consults no policy. Seeing the row is membership; ` +
        `acting on it is not. Call ${ASKS_FIRST} before the credential is fetched, or ` +
        `add the handler to READ_ONLY_BY_DESIGN with the reason it is safe without it.`,
    ).toEqual([]);
  });

  it.each(Object.keys(READ_ONLY_BY_DESIGN))("still needs its exemption: %s", (label) => {
    // An exemption outliving its reason is how a list like this rots.
    const handler = routes.find((h) => h.label === label);
    expect(handler, `${label} is in READ_ONLY_BY_DESIGN but no longer exists`).toBeDefined();
    expect(
      reachesTheGrant(handler!),
      `${label} no longer reaches the grant — remove it from READ_ONLY_BY_DESIGN`,
    ).toBe(true);
    expect(
      READ_ONLY_BY_DESIGN[label].length,
      `${label}'s reason is too short to be one`,
    ).toBeGreaterThan(30);
  });
});
