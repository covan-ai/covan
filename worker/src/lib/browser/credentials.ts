import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { decryptSecret, encryptSecret } from "../secret-box";
import { serviceClient } from "../supabase";
import { bareHost } from "./outcome";
import type { SecretBinding } from "./v4";

/**
 * The login you save: a site's username and password, kept for one agent so
 * its browser can sign in without asking every time (0079).
 *
 * The one module that reads or writes `browser_credentials`, and the one place
 * in this product a password a person typed for a site is ever in the clear.
 * It is in the clear twice: on the way in, for as long as `encryptSecret`
 * takes, and on the way out, inside the `SecretBinding[]` `credentialsFor`
 * hands to a run. Everything else this file returns — a save's answer, the
 * label, the id, `hasSavedCredential`'s boolean — is built so that it cannot
 * carry either half, because every one of them ends up in a response body, a
 * proposal card or a log line somebody will read.
 *
 * **Through the service role, for 0079's reasons.** No client role may write
 * the table at all (saving means encrypting, which only the worker can do), and
 * neither ciphertext is granted to any client role, so neither the write nor
 * the read the binding needs could be made with a user client even if there
 * were one. The route in front of a save or a forget has already asked, through
 * the caller's own client, whether the caller may use the agent; what this file
 * re-checks with the service role is only what a caller's word must not settle:
 * that the agent is the workspace's (the read policy does not check it, so the
 * write must get it right), whether a shared login's saver is still a member of
 * the workspace it was saved in (R29), and who is a workspace admin.
 *
 * **Never a value in a log line.** Logs carry a row id and a status code, and a
 * database error is reduced to its code before it goes anywhere: an error's
 * `details` can quote the row that failed, and this row is a password.
 */

/** Injected as `sessions.ts` injects its own; `??` against the real thing. */
export type CredentialDeps = { db: SupabaseClient; now: () => Date };

function resolve(env: RoutineEnv, overrides: Partial<CredentialDeps>): CredentialDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
  };
}

/** A database failure, as a sentence that can carry no column value. */
function failed(what: string, error: { code?: string } | null): Error {
  return new Error(`browser_credentials: ${what} failed (${error?.code ?? "no code"})`);
}

export type CredentialScope = "owner" | "agent";

/**
 * The host a login is saved for, the host a run asks about, and the one
 * `allowedDomains` is handed — all three through here, so they cannot
 * disagree (R25, R30).
 *
 * `bareHost`'s repairs first (trimmed, case folded, a URL reduced to its
 * hostname, a port stripped), because a person pasting `https://www.LinkedIn
 * .com/feed` into the save dialog means `linkedin.com` exactly as much as a
 * model reporting it does. Then the hostname as a URL parser spells it, which
 * is what turns `münchen.de` into the punycode a browser actually visits. Then
 * a leading `www.` goes, because the provider's rule is that "a host covers its
 * subdomains": a login saved for `linkedin.com` is typed on `www.linkedin.com`,
 * and one saved for `www.linkedin.com` would not be typed on the bare domain
 * the site may well redirect its login form to.
 *
 * What is left must look like a public hostname — dot-separated labels of
 * letters, digits and inner hyphens, at least two of them. A dotless name is
 * refused on purpose: the browser runs at the provider, which cannot reach
 * `intranet`, and a login nothing can ever be typed into is a password kept
 * for no reason. Anything that is not the shape after all that is refused, not
 * stored — 0079's check would catch only part of it, and a host that never
 * matches is a login that silently never works.
 */
export function siteHostOf(value: string): string | null {
  const bare = bareHost(value);
  if (!bare) return null;
  let host: string;
  try {
    host = new URL(`http://${bare}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ? host : null;
}

/**
 * The provider's alias rule: "1–64 lowercase letters, digits, hyphens, or
 * underscores and start with a letter or digit". An alias it refuses is a run
 * it refuses at create, so the longest one this file makes — `<slug>_password`
 * — has to fit it for every host `siteHostOf` accepts, and a host may be 253
 * characters long.
 */
const ALIAS_MAX = 64;
const LONGEST_SUFFIX = "_password";
const SLUG_MAX = ALIAS_MAX - LONGEST_SUFFIX.length;

/** FNV-1a, 32 bits, as eight hex digits: small, synchronous, and the same on every runtime. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `linkedin.com` → `linkedin_com`: the stem of both aliases a run names (R31).
 *
 * Lowercase, every non-alphanumeric folded to `_`, and a leading `h` when the
 * result would not start with a letter or digit (no host `siteHostOf` accepts
 * needs it; the guarantee is for whatever else is handed in). A slug that fits
 * is returned unchanged, so every short host keeps the aliases it always had.
 * One that does not keeps its start — the part a person reading the task text
 * recognises — and ends in `_` and a hash of the whole host, so two long hosts
 * that differ only at the end still name different aliases, and the same host
 * names the same ones on every run.
 */
export function credentialSlug(siteHost: string): string {
  let slug = siteHost.toLowerCase().replace(/[^a-z0-9]/g, "_");
  if (!/^[a-z0-9]/.test(slug)) slug = `h${slug}`;
  if (slug.length <= SLUG_MAX) return slug;
  const hash = fnv1a(siteHost);
  return `${slug.slice(0, SLUG_MAX - hash.length - 1)}_${hash}`;
}

/**
 * The two aliases a saved login for `siteHost` is bound under. Exported so the
 * task text (2.3) names exactly what `credentialsFor` binds — one function,
 * not two spellings that could drift.
 */
export function credentialAliases(siteHost: string): { username: string; password: string } {
  const slug = credentialSlug(siteHost);
  return { username: `${slug}_username`, password: `${slug}${LONGEST_SUFFIX}` };
}

/**
 * Each half, in UTF-8 bytes (R26). The provider takes 4096 bytes per inline
 * value once encoded for its own encryption; half of that leaves its envelope
 * room, and no real username or password is anywhere near it.
 */
export const CREDENTIAL_MAX_BYTES = 2048;

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export type SaveCredentialInput = {
  workspaceId: string;
  agentId: string;
  userId: string;
  scope: CredentialScope;
  siteHost: string;
  label: string;
  username: string;
  password: string;
};

export type SaveRefusal =
  | "invalid_scope"
  | "invalid_host"
  | "invalid_label"
  | "label_is_username"
  | "label_is_password"
  | "invalid_username"
  | "invalid_password"
  | "agent_not_found"
  | "shared_exists";

/** What a save answers. Never either half of the login, in any branch. */
export type SaveCredentialResult =
  | {
      ok: true;
      credential: {
        id: string;
        scope: CredentialScope;
        siteHost: string;
        label: string;
        /** True when an existing login of the saver's was overwritten in place. */
        replaced: boolean;
      };
    }
  | { ok: false; reason: SaveRefusal; message: string };

function refuse(reason: SaveRefusal, message: string): SaveCredentialResult {
  return { ok: false, reason, message };
}

/**
 * Validation, in the order a dialog would want the complaints. The messages
 * are the route's to show as they are, so none of them quotes what was typed:
 * the label check in particular is about the username, and "your label
 * contains ada@…" would be the leak it exists to prevent.
 */
function check(
  input: SaveCredentialInput,
):
  | { ok: true; siteHost: string; label: string; username: string }
  | { ok: false; refusal: SaveCredentialResult } {
  const no = (reason: SaveRefusal, message: string) => ({
    ok: false as const,
    refusal: refuse(reason, message),
  });
  if (input.scope !== "owner" && input.scope !== "agent") {
    return no("invalid_scope", "a login is saved either for you or for everyone using this agent");
  }
  const siteHost = siteHostOf(String(input.siteHost ?? ""));
  if (!siteHost)
    return no("invalid_host", "that is not a website address a login can be saved for");

  // The username is trimmed — a pasted address with a trailing space is the
  // same address — and the password is not: a space can be part of one.
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  if (!username || bytes(username) > CREDENTIAL_MAX_BYTES) {
    return no(
      "invalid_username",
      `the username must be between 1 and ${CREDENTIAL_MAX_BYTES} bytes`,
    );
  }
  if (!password || bytes(password) > CREDENTIAL_MAX_BYTES) {
    return no(
      "invalid_password",
      `the password must be between 1 and ${CREDENTIAL_MAX_BYTES} bytes`,
    );
  }

  // The label is what colleagues see on a shared login, so it must not be the
  // login: the username is encrypted precisely because it is often the more
  // personal half (0079). Case-insensitive, because `Ada@Example.com` in a
  // label discloses exactly what `ada@example.com` would.
  const label = String(input.label ?? "").trim();
  if (!label) return no("invalid_label", "give the login a name, like “LinkedIn — sales account”");
  if (label.toLowerCase().includes(username.toLowerCase())) {
    return no(
      "label_is_username",
      "the name is shown to others, so it cannot contain the username",
    );
  }
  // The same, for the half that matters most: a label is stored in the clear
  // and listed to colleagues, so a password pasted into it — the field below
  // the password one, easy to mistype into — would be the one place a
  // password sat unencrypted. Case-insensitive for the username's reason.
  if (label.toLowerCase().includes(password.toLowerCase())) {
    return no(
      "label_is_password",
      "the name is shown to others, so it cannot contain the password",
    );
  }
  return { ok: true, siteHost, label, username };
}

type ExistingRow = { id: string; user_id: string };

/** The row a save of this (scope, agent, [person,] site) would collide with — 0079's two partial uniques. */
async function existing(
  db: SupabaseClient,
  input: { scope: CredentialScope; agentId: string; userId: string; siteHost: string },
): Promise<ExistingRow | null> {
  let query = db
    .from("browser_credentials")
    .select("id, user_id")
    .eq("agent_id", input.agentId)
    .eq("site_host", input.siteHost)
    .eq("scope", input.scope);
  if (input.scope === "owner") query = query.eq("user_id", input.userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw failed("read", error);
  return (data as ExistingRow | null) ?? null;
}

/**
 * Save, or replace, a login (2.4's dialog; 2.3's "update the saved login").
 *
 * Replacing your own row is how a login is updated, so the same (scope, agent,
 * [person,] site) overwrites in place and keeps its id. A shared login somebody
 * else saved is not yours to overwrite — 0079 allows one per site per agent
 * (R28), and a second member's save is refused in words the dialog can show
 * rather than as the 23505 the partial unique would raise. The read-then-write
 * is not atomic, which is why the 23505 is caught too: a save that loses the
 * race goes round once more and lands on whichever answer the winner left.
 *
 * Not an upsert: PostgREST's `on_conflict` names columns, and 0079's uniques
 * are partial indexes, which `on conflict (cols)` cannot target without the
 * index's own predicate.
 */
export async function saveCredential(
  env: RoutineEnv,
  input: SaveCredentialInput,
  overrides: Partial<CredentialDeps> = {},
): Promise<SaveCredentialResult> {
  const valid = check(input);
  if (!valid.ok) return valid.refusal;
  const { siteHost, label, username } = valid;
  const { db } = resolve(env, overrides);

  // The route asked, through the caller's own client, whether the caller may
  // use this agent. It did not ask whether the agent is the workspace's the
  // row will name — 0079's read policy shows a shared login to that
  // workspace's members, so a row naming one workspace and another's agent
  // would show a login to people who cannot use it. Settled here, with the
  // only client this file has, against the agent row rather than the caller.
  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("id")
    .eq("id", input.agentId)
    .eq("workspace_id", input.workspaceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (agentError) throw failed("agent read", agentError);
  if (!agent) return refuse("agent_not_found", "that agent is not in this workspace");

  const sealed = {
    label,
    username_ciphertext: await encryptSecret(username, env.ROUTINE_SECRET_KEY),
    password_ciphertext: await encryptSecret(input.password, env.ROUTINE_SECRET_KEY),
  };
  const shared = () => refuse("shared_exists", `a shared login for ${siteHost} already exists`);
  const saved = (id: string, replaced: boolean): SaveCredentialResult => ({
    ok: true,
    credential: { id, scope: input.scope, siteHost, label, replaced },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await existing(db, { ...input, siteHost });
    if (found) {
      if (found.user_id !== input.userId) return shared();
      const { data, error } = await db
        .from("browser_credentials")
        .update(sealed)
        .eq("id", found.id)
        .eq("user_id", input.userId)
        .select("id");
      if (error) throw failed("update", error);
      // Forgotten between the read and the write: go round and insert.
      if ((data as unknown[] | null)?.length) return saved(found.id, true);
      continue;
    }

    const { data, error } = await db
      .from("browser_credentials")
      .insert({
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        user_id: input.userId,
        scope: input.scope,
        site_host: siteHost,
        ...sealed,
      })
      .select("id")
      .single();
    if (error?.code === "23505") continue;
    if (error || !data) throw failed("insert", error);
    return saved(String((data as { id: string }).id), false);
  }
  // Lost the race twice. For a shared login that is somebody else's save
  // arriving between every read and write; for a personal one it is the same
  // person saving from two tabs at once. Either way the row exists, and the
  // dialog's honest answer is the shared refusal or a retry.
  if (input.scope === "agent") return shared();
  throw failed("save", { code: "23505" });
}

type CredentialRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  scope: CredentialScope;
  site_host: string;
  label: string;
  username_ciphertext?: string;
  password_ciphertext?: string;
};

const LISTED = "id, workspace_id, user_id, scope, site_host, label";

/** Whether `userId` is in `workspaceId`, and as what — `workspace_members`, as `slack.ts` asks it. */
async function memberRole(
  db: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw failed("membership read", error);
  return data ? String((data as { role: string }).role) : null;
}

/**
 * The one login a run of `agentId` for `userId` on `host` would sign in with:
 * the caller's own, else the agent's shared one while its saver is still a
 * member of the workspace it was saved in (R29), else none. `credentialsFor`,
 * `savedLogin` and `hasSavedCredential` all choose through here, so the card,
 * the binding and deliver's "a login is saved" can never name different logins.
 *
 * Two reads rather than one with an `or`, so the read that could carry
 * somebody else's personal row never exists: each is narrowed to exactly the
 * rows it may use.
 *
 * **On `host` or a parent of it (R37, replacing R30's exact match).** A wall on
 * `accounts.linkedin.com` and a login saved for `linkedin.com` are one site —
 * the provider types a binding on its `allowedDomains` host "and its
 * subdomains" — so when nothing is saved for the host itself the pick walks up
 * to the nearest parent that has a login, the longest match first (see
 * `hostAndParents`). Never down, and never wider than the row: the binding's
 * `allowedDomains` is still the row's own `site_host`.
 *
 * **`prefer` (R35)** names one row to try first — the login a save on the
 * sign-in card just returned, so the hand-back binds THAT login rather than
 * the caller's own one that has just failed, which the ordinary order would
 * choose again. It is a preference, not an instruction: honoured only for a
 * row on this agent and this site (or a parent of it) that the caller could
 * have been given anyway — their own personal row, or a shared one whose saver is still a
 * member (R29). Anything else — a colleague's personal row, another agent's,
 * another site's — is passed over, and the ordinary pick answers.
 */
async function pick(
  db: SupabaseClient,
  args: { agentId: string; userId: string; host: string; prefer?: string | null },
  columns: string,
): Promise<CredentialRow | null> {
  const siteHost = siteHostOf(String(args.host ?? ""));
  if (!siteHost) return null;
  const hosts = hostAndParents(siteHost);

  if (args.prefer) {
    const { data: named, error: namedError } = await db
      .from("browser_credentials")
      .select(columns)
      .eq("id", args.prefer)
      .eq("agent_id", args.agentId)
      .in("site_host", hosts)
      .maybeSingle();
    if (namedError) throw failed("read", namedError);
    const row = named as unknown as CredentialRow | null;
    if (row?.scope === "owner" && row.user_id === args.userId) return row;
    if (row?.scope === "agent" && (await memberRole(db, row.workspace_id, row.user_id))) {
      return row;
    }
  }

  const { data: own, error: ownError } = await db
    .from("browser_credentials")
    .select(columns)
    .eq("agent_id", args.agentId)
    .in("site_host", hosts)
    .eq("scope", "owner")
    .eq("user_id", args.userId);
  if (ownError) throw failed("read", ownError);
  const owns = (own as unknown as CredentialRow[] | null) ?? [];
  // The caller's own login for the host itself beats anything else, so the
  // shared read is skipped for it, as it always was.
  const exact = owns.find((r) => r.site_host === siteHost);
  if (exact) return exact;

  const { data: shared, error: sharedError } = await db
    .from("browser_credentials")
    .select(columns)
    .eq("agent_id", args.agentId)
    .in("site_host", hosts)
    .eq("scope", "agent");
  if (sharedError) throw failed("read", sharedError);

  const shares = (shared as unknown as CredentialRow[] | null) ?? [];
  // The host itself first, then each parent from the nearest up (R37); at each
  // one the caller's own login, else the shared one — the order R30 always
  // had, now repeated a level at a time.
  for (const host of hosts) {
    const mine = owns.find((r) => r.site_host === host);
    if (mine) return mine;
    const theirs = shares.find((r) => r.site_host === host);
    // Asked of the row's own workspace and the row's own saver, never of
    // anything the caller sent. A saver who has left keeps the row — a
    // re-invited person should not have to type the password again — but the
    // agent stops signing in as them (0079's header, R29), and the walk goes
    // on up.
    if (theirs && (await memberRole(db, theirs.workspace_id, theirs.user_id))) return theirs;
  }
  return null;
}

/**
 * `accounts.linkedin.com` → `["accounts.linkedin.com", "linkedin.com"]`: the
 * host, then every parent a login could have been saved for, nearest first
 * (R37). Only parents of two labels or more, because `siteHostOf` refuses a
 * dotless host and so no row is ever saved for `com`. Never a child: the walk
 * only goes up, so a login saved for `accounts.example.com` is not offered on
 * `example.com`, and whole labels only, so `inkedin.com` is no parent of
 * `linkedin.com`.
 */
function hostAndParents(siteHost: string): string[] {
  const labels = siteHost.split(".");
  const hosts: string[] = [];
  for (let i = 0; labels.length - i >= 2; i++) hosts.push(labels.slice(i).join("."));
  return hosts;
}

/**
 * A saved login named, not opened: what a screen or a card may say about it.
 * Nothing in it was ever encrypted, so nothing in it can be the login.
 */
export type SavedLogin = {
  id: string;
  /** The saver's words, for the card (2.3) and the hand-back (2.4). Never the username. */
  label: string;
  scope: CredentialScope;
  siteHost: string;
};

/** A login a run may sign in with. The plaintext lives in `bindings` and nowhere else. */
export type CredentialBinding = SavedLogin & {
  /**
   * The two alias names the bindings are under — `credentialAliases(siteHost)`
   * — carried beside them so the task text (`conversationRun`) names exactly
   * what is bound without importing this file or telling the halves apart by
   * position. Names, not values: the agent is meant to read these.
   */
  aliases: { username: string; password: string };
  bindings: SecretBinding[];
};

/**
 * The saved login for a run on `host`, as the two `SecretBinding`s browser-use
 * types from (R30), or null when there is none the caller may use.
 *
 * The only function in this product that decrypts a saved login. Both
 * bindings' `allowedDomains` is the row's own `site_host` — never a host from
 * the task text or the page, because a domain the model chose is a domain a
 * page could have talked it into (Review focus 4). The aliases are
 * `credentialAliases` — `<slug>_username` and `<slug>_password` — which is
 * what the task text names and the agent asks for; the values never reach
 * the agent.
 *
 * A row that will not decrypt — a rotated key, a tampered column — answers
 * null and logs its id: a run without the binding meets the login wall and
 * says so, which is the right failure; a run that threw here would not start.
 */
export async function credentialsFor(
  env: RoutineEnv,
  /** `prefer`: a row to bind if the caller may (R35) — see `pick`. */
  args: { agentId: string; userId: string; host: string; prefer?: string | null },
  overrides: Partial<CredentialDeps> = {},
): Promise<CredentialBinding | null> {
  const { db, now } = resolve(env, overrides);
  const row = await pick(db, args, `${LISTED}, username_ciphertext, password_ciphertext`);
  if (!row) return null;

  let username: string;
  let password: string;
  try {
    username = await decryptSecret(String(row.username_ciphertext), env.ROUTINE_SECRET_KEY);
    password = await decryptSecret(String(row.password_ciphertext), env.ROUTINE_SECRET_KEY);
  } catch {
    console.error("a saved browser login would not decrypt", row.id);
    return null;
  }

  // Best-effort: the screen's "last used" is a convenience, and a run that
  // lost its binding because a timestamp did not write would be a worse
  // answer than a stale timestamp.
  try {
    const { error } = await db
      .from("browser_credentials")
      .update({ last_used_at: now().toISOString() })
      .eq("id", row.id);
    if (error) console.warn("could not record a saved login's last use", row.id, error.code);
  } catch {
    console.warn("could not record a saved login's last use", row.id);
  }

  const aliases = credentialAliases(row.site_host);
  const allowedDomains = [row.site_host];
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    siteHost: row.site_host,
    aliases,
    bindings: [
      { alias: aliases.username, source: { type: "inline", value: username }, allowedDomains },
      { alias: aliases.password, source: { type: "inline", value: password }, allowedDomains },
    ],
  };
}

/**
 * Whether a run of `agentId` for `userId` on `host` would have been given a
 * saved login (R27) — for `deliver.ts`, which, when a run that carried none
 * hits a login wall, adds that asking again would use it. Never the ground for
 * "the saved login did not work": a login merely saved was not necessarily
 * tried, and only `browser_tasks.credential_id` says it was (R32,
 * `credentialCoversHost`). A boolean and nothing else, chosen by the same rule
 * as the binding, without reading a ciphertext or touching `last_used_at`.
 */
export async function hasSavedCredential(
  env: RoutineEnv,
  args: { agentId: string; userId: string; host: string },
  overrides: Partial<CredentialDeps> = {},
): Promise<boolean> {
  return (await savedLogin(env, args, overrides)) !== null;
}

/**
 * Which saved login a run of `agentId` for `userId` on `host` would sign in
 * with, by name — for `browse`'s approval card (2.3), which says "signs in as
 * linkedin.com (saved login: <label>)" before anybody has agreed to anything.
 *
 * Chosen by the same rule as the binding, so the card names the login the run
 * will carry. And not `credentialsFor`, on purpose: a card somebody declines
 * must leave nothing behind, and `credentialsFor` decrypts the login and marks
 * it used. This reads no ciphertext and writes nothing.
 */
export async function savedLogin(
  env: RoutineEnv,
  args: { agentId: string; userId: string; host: string },
  overrides: Partial<CredentialDeps> = {},
): Promise<SavedLogin | null> {
  const { db } = resolve(env, overrides);
  const row = await pick(db, args, LISTED);
  return row ? { id: row.id, label: row.label, scope: row.scope, siteHost: row.site_host } : null;
}

/**
 * Whether the saved login `credentialId` — the one a run CARRIED, from
 * `browser_tasks.credential_id` (R32) — is for `host`, the site that walled the
 * run. For `deliver.ts`: "the saved login did not work" is true only of a login
 * the browser could have typed there.
 *
 * "For" is the provider's rule — the same one `pick` walks up by since R37.
 * `pick` chooses which login to hand a run; this asks where that login could
 * be typed, and the provider types a binding on its
 * `allowedDomains` host "and its subdomains" — so a login saved for
 * `linkedin.com` was there to be used on `accounts.linkedin.com`, and is what
 * failed. A login for one site that walled on another (a sign-in handed over to
 * a single sign-on provider) was never asked for, and answers false.
 *
 * The row's host and nothing else; no ciphertext, no `last_used_at`. False for
 * a login forgotten since the run (the task's column is then null anyway) and
 * for a host that is not one. Throws on a read error, as `pick` does; the
 * caller decides what not knowing costs.
 */
export async function credentialCoversHost(
  env: RoutineEnv,
  args: { credentialId: string; host: string },
  overrides: Partial<CredentialDeps> = {},
): Promise<boolean> {
  const host = siteHostOf(String(args.host ?? ""));
  if (!host) return false;
  const { db } = resolve(env, overrides);
  const { data, error } = await db
    .from("browser_credentials")
    .select("site_host")
    .eq("id", args.credentialId)
    .maybeSingle();
  if (error) throw failed("read", error);
  if (!data) return false;
  const saved = String((data as { site_host: string }).site_host);
  return host === saved || host.endsWith(`.${saved}`);
}

export type ForgetCredentialResult =
  { ok: true } | { ok: false; reason: "not_found" | "forbidden" };

/**
 * Delete a saved login (R29). The saver may always delete their own, in either
 * scope, member or not — it is their password. A workspace admin may also
 * delete a `scope = 'agent'` login of that workspace: a shared login is the
 * team's to stop using even when its saver is away. Nobody else.
 *
 * Refusals are answered, not thrown, and they are shaped like what the caller
 * can see (0079's read policy): somebody else's personal login, a row in a
 * workspace the caller is not in, and no row at all are all `not_found`,
 * because none of them is anything the caller can see exists. Only a shared
 * login the caller CAN see — a member who is neither its saver nor an admin —
 * is `forbidden`. Admin is `workspace_members.role = 'admin'`, as 0003's
 * `is_workspace_admin` and every route here decide it.
 *
 * Each delete repeats its own condition in the predicate, so a row whose
 * scope or owner changed between the read and the delete is not removed.
 */
export async function forgetCredential(
  env: RoutineEnv,
  args: { credentialId: string; userId: string },
  overrides: Partial<CredentialDeps> = {},
): Promise<ForgetCredentialResult> {
  const { db } = resolve(env, overrides);
  const { data, error } = await db
    .from("browser_credentials")
    .select("id, workspace_id, user_id, scope")
    .eq("id", args.credentialId)
    .maybeSingle();
  if (error) throw failed("read", error);
  if (!data) return { ok: false, reason: "not_found" };
  const row = data as Pick<CredentialRow, "id" | "workspace_id" | "user_id" | "scope">;

  let deletion;
  if (row.user_id === args.userId) {
    deletion = db.from("browser_credentials").delete().eq("id", row.id).eq("user_id", args.userId);
  } else {
    if (row.scope !== "agent") return { ok: false, reason: "not_found" };
    const role = await memberRole(db, row.workspace_id, args.userId);
    if (!role) return { ok: false, reason: "not_found" };
    if (role !== "admin") return { ok: false, reason: "forbidden" };
    deletion = db
      .from("browser_credentials")
      .delete()
      .eq("id", row.id)
      .eq("scope", "agent")
      .eq("workspace_id", row.workspace_id);
  }

  const { data: gone, error: deleteError } = await deletion.select("id");
  if (deleteError) throw failed("delete", deleteError);
  return (gone as unknown[] | null)?.length ? { ok: true } : { ok: false, reason: "not_found" };
}

/**
 * Which of `taskIds` — the caller's own — carried a saved login (R32), for the
 * sign-in card (2.4): over a run that did, it says the saved login did not
 * work and offers to update it; over one that did not, it offers to save one.
 *
 * A set of task ids and nothing else. `browser_tasks.credential_id` is granted
 * to no client role (0079), and the screen has no use for WHICH login — only
 * for whether there was one — so the id is read here, with the service role,
 * and reduced to a yes before it leaves. `user_id` is in the predicate rather
 * than trusted from the caller's earlier read, because this client answers to
 * no policy. Throws on a read error, as `pick` does; the route decides that
 * not knowing is "no".
 */
export async function tasksThatCarriedALogin(
  env: RoutineEnv,
  args: { userId: string; taskIds: string[] },
  overrides: Partial<CredentialDeps> = {},
): Promise<Set<string>> {
  if (args.taskIds.length === 0) return new Set();
  const { db } = resolve(env, overrides);
  const { data, error } = await db
    .from("browser_tasks")
    .select("id, credential_id")
    .in("id", args.taskIds)
    .eq("user_id", args.userId);
  if (error) throw failed("carried read", error);
  return new Set(
    ((data as Array<{ id: string; credential_id: string | null }> | null) ?? [])
      .filter((row) => row.credential_id != null)
      .map((row) => String(row.id)),
  );
}
