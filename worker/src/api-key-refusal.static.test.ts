import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on the one sentence an API key is not allowed to break.
 *
 * A key is not a scope list — it is a way to become the person who owns it, and
 * RLS decides the rest. `lib/api-key-rule.ts` holds the single exception: a key
 * may not create access that survives its own revocation, because revoking a
 * leaked key has to be the end of the incident rather than the middle of one.
 *
 * Nothing about that rule is enforceable by the database, and that is what
 * makes forgetting it quiet. A key authenticates as its owner, so a route that
 * creates access and never asks behaves identically for a key and for a
 * session: same 200, same row, every policy satisfied, every other test in this
 * repo still green. The only evidence arrives later, when a revoked key's
 * invitee is still an admin and nobody can say which call let them in.
 *
 * `POST /invitations` and `PATCH /workspace/members/:userId` were exactly that
 * for the whole life of the feature — finding 7 of the 2026-10-08 audit — while
 * the reasoning that forbids them sat written out in `routes/api-keys.ts` two
 * files away. Two routes asked, two routes that did the same thing did not, and
 * the difference was invisible.
 *
 * So the files are pinned, and the rule is pinned to one place. The real fix is
 * to invert it — a key's powers as an allowlist, so forgetting is impossible —
 * and until that is done this is what notices. The list only ever grows: every
 * new route that hands out access or destroys an account belongs on it.
 *
 * What it looks for is a *call*, and comments are stripped before it looks. The
 * first draft of this file asked only whether the name appeared in the file,
 * and `import { refuseIfKeyAuthenticated } from …` is the name appearing in the
 * file: deleting the two-line refusal from `routes/workspace.ts` and leaving
 * the import satisfied it, with finding 7 reopened. Nothing else would have
 * caught the orphan either — `no-unused-vars` is off for this package and
 * `noUnusedLocals` is not set.
 */
const SRC = join(process.cwd(), "src");

/** The helper that states the rule, and the names that count as asking. */
const RULE = "lib/api-key-rule.ts";
const ASKS = ["refuseIfKeyAuthenticated(", 'c.get("apiKeyId")'];

/**
 * Routes that create access an API key must not create, and what they create.
 *
 * Each line is a claim that a leaked key reaching this route would outlive its
 * own revocation. The reasons are kept short here because the argument for each
 * is written once, in the helper's docblock.
 */
const ACTS_BEYOND_THE_KEY: Record<string, string> = {
  "routes/browser.ts":
    "mints a live browser URL carrying the owner's own signed-in cookies, and browser-use documents that URL as full control of that browser — so it is access that outlives the key by the whole session, and revoking the key does not touch it; and it saves a site's password for an agent, which signs in as that person on every later run long after the key is revoked",
  "routes/api-keys.ts":
    "mints and revokes keys: a key that writes successors cannot be revoked, and a leaked one can take down the keys somebody still relies on",
  "routes/account.ts":
    "closes the account, which destroys the evidence and the account in one call and cannot be undone by revoking anything",
  "routes/invitations.ts":
    "invites people, and what comes back is a second person with their own session — access in a third party's hands that revoking the key does not touch",
  "routes/workspace.ts":
    "changes what a member may do, so a viewer promoted to admin by a key stays an admin after the key is gone",
};

/**
 * Single handlers that create access a key must not create, checked one by one.
 *
 * `ACTS_BEYOND_THE_KEY` asks whether a FILE refuses a key somewhere, and that
 * is blind inside a file: `routes/browser.ts`'s `GET .../current` handed back
 * a live URL with no refusal of its own while `POST`'s answered for it. So the
 * routes that hand somebody a browser are pinned by handler — the text from
 * `.<method>("<path>"` to the next registration must itself make the call.
 *
 * Keyed `"<file> <METHOD> <path>"`.
 */
const HANDLERS_BEYOND_THE_KEY: Record<string, string> = {
  "routes/browser.ts GET /browser/sessions/:id/live":
    "hands back the live view URL of a browser carrying the owner's signed-in cookies — a credential the provider says gives full control of that browser, and revoking the key does not end it",
  "routes/browser.ts POST /browser/sessions/:id/take-over":
    "puts the owner's browser in human hands, which is the state in which the panel's live URL becomes the controls of a browser carrying their signed-in sessions",
  "routes/browser.ts POST /browser/sessions/:id/hand-back":
    "starts a run in the owner's signed-in browser and spends the one free retry on their behalf, an act the owner never took that outlives the key",
  "routes/browser.ts POST /browser/sessions/:id/stop":
    "stops somebody's browser, ending a sign-in they may be in the middle of and deciding what their cookie jar keeps",
  "routes/browser.ts POST /browser/tasks/:id/cancel":
    "takes a task somebody approved out of their browser's line, deciding what their browser does next on their behalf",
  "routes/browser.ts GET /browser/sessions":
    "lists which of somebody's browsers are open right now, in which conversations and in whose hands — a map of where a signed-in browser of theirs can be found, read the way GET /browser/profile and GET /browser/credentials are refused: reconnaissance rather than work, which no key-driven caller needs",
  "routes/browser.ts GET /browser/credentials":
    "lists which sites somebody has a saved login for, and on which agents — reconnaissance about where their passwords are kept, which no key-driven caller needs",
  "routes/browser.ts POST /browser/credentials":
    "saves a site's password for an agent, so every later run signs in as that person — a login planted by a key keeps working after the key is revoked",
  "routes/browser.ts DELETE /browser/credentials/:id":
    "forgets a saved login, possibly a shared one the whole team's agent signs in with — a destructive act on their behalf that revoking the key does not undo",
};

/**
 * Files permitted to read `apiKeyId` off the context directly.
 *
 * Everything else asks through the helper, so the rule is stated once and the
 * reasoning lives next to it. A third hand-rolled copy is how the two routes in
 * finding 7 came to disagree with the two that asked.
 */
const TOUCHES_THE_BINDING = new Map([
  ["types.ts", "declares the context variable"],
  ["middleware/auth.ts", "sets it — the one place a key becomes a caller"],
  [RULE, "states the rule"],
]);

/** Every source file under src/, excluding tests and their scaffolding. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (entry === "test-support") continue;
      out.push(...sourceFiles(full, rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

const files = sourceFiles(SRC);

/**
 * The same text with its comments removed.
 *
 * Crude — a `//` inside a string literal goes with them unless a `:` precedes
 * it. It does not need to be better: what it is for is making sure a claim
 * written in a comment cannot stand in for the code that would honour it.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function mentions(file: string, needle: string): boolean {
  return codeOnly(readFileSync(join(SRC, file), "utf8")).includes(needle);
}

describe("the one thing an API key may not do", () => {
  it("has a source tree and a rule to look at", () => {
    // Without this, a bad path would make every assertion below pass on nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(RULE);
    expect(mentions(RULE, "export function refuseIfKeyAuthenticated(")).toBe(true);
    // And the needles are call shapes, not bare names, so an orphan import
    // cannot answer for a refusal that was deleted.
    expect(ASKS.every((needle) => needle.includes("("))).toBe(true);
  });

  it("is refused by every route that could create access outliving a key", () => {
    const silent = Object.keys(ACTS_BEYOND_THE_KEY).filter(
      (file) => !ASKS.some((name) => mentions(file, name)),
    );

    expect(
      silent,
      "these create access a revoked key would leave behind, and no longer refuse a " +
        "key-authenticated caller. A key authenticates as its owner, so nothing else " +
        `in this repo can notice. Call ${ASKS[0]}c, …) from ${RULE}, or — if the route ` +
        "genuinely stopped creating access — remove it from ACTS_BEYOND_THE_KEY.",
    ).toEqual([]);
  });

  it("states the rule in one place", () => {
    const copies = files.filter((f) => !TOUCHES_THE_BINDING.has(f) && mentions(f, '"apiKeyId"'));

    expect(
      copies,
      `these read apiKeyId off the context themselves instead of asking ${ASKS[0]}. ` +
        "The rule and its reasoning belong in one file; a second copy is how two " +
        "routes came to disagree with the two that asked.",
    ).toEqual([]);
  });

  it.each(Object.keys(ACTS_BEYOND_THE_KEY))("is still a route that creates access: %s", (file) => {
    // An entry outliving its reason is how a list like this rots.
    expect(files, `${file} is in ACTS_BEYOND_THE_KEY but no longer exists`).toContain(file);
    expect(
      ASKS.some((name) => mentions(file, name)),
      `${file} no longer refuses a key — either the refusal was lost, or the route ` +
        "stopped creating access and the entry should go",
    ).toBe(true);
    expect(
      ACTS_BEYOND_THE_KEY[file].length,
      `${file}'s reason is too short to be one`,
    ).toBeGreaterThan(30);
  });

  it.each(Object.keys(HANDLERS_BEYOND_THE_KEY))("is refused by the handler itself: %s", (key) => {
    const [file, method, path] = key.split(" ");
    expect(files, `${file} is in HANDLERS_BEYOND_THE_KEY but no longer exists`).toContain(file);

    const code = codeOnly(readFileSync(join(SRC, file), "utf8"));
    const start = code.indexOf(`.${method.toLowerCase()}("${path}"`);
    expect(start, `${key} is no longer registered in ${file}`).toBeGreaterThanOrEqual(0);
    // To the next handler registered on any router, or the end of the file.
    const rest = code.slice(start + 1);
    const next = rest.search(/\n\w+\.(get|post|put|patch|delete)\(/);
    const handler = next === -1 ? rest : rest.slice(0, next);

    expect(
      ASKS.some((name) => handler.includes(name)),
      `${key} creates access a revoked key would leave behind and does not refuse a key itself`,
    ).toBe(true);
    expect(
      HANDLERS_BEYOND_THE_KEY[key].length,
      `${key}'s reason is too short to be one`,
    ).toBeGreaterThan(30);
  });

  it.each([...TOUCHES_THE_BINDING.keys()])("still needs to name the binding: %s", (file) => {
    expect(files, `${file} is allowlisted but no longer exists`).toContain(file);
    expect(
      mentions(file, "apiKeyId"),
      `${file} no longer names apiKeyId — remove it from TOUCHES_THE_BINDING`,
    ).toBe(true);
  });
});
