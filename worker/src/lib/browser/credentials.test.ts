import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { QueryContext, QueryResult } from "../../test-support/fake-db";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { decryptSecret, encryptSecret } from "../secret-box";
import {
  credentialAliases,
  credentialCoversHost,
  credentialSlug,
  credentialsFor,
  forgetCredential,
  hasSavedCredential,
  saveCredential,
  savedLogin,
  siteHostOf,
  tasksThatCarriedALogin,
  type CredentialDeps,
} from "./credentials";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY } as RoutineEnv;
const NOW = new Date("2026-10-10T12:00:00.000Z");

const WS = "ws-1";
const OTHER_WS = "ws-2";
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const ADA = "user-ada";
const BOB = "user-bob";
const CAT = "user-cat";
const ADMIN = "user-admin";
const STRANGER = "user-stranger";

// Distinctive enough that a substring search for them cannot match anything
// else this file or the module ever writes.
const ADA_USER = "ada.lovelace@example.com";
const ADA_PASS = "hunter2-correct-horse";
const BOB_USER = "bob.builder@example.com";
const BOB_PASS = "staple-battery-9271";
const SECRETS = [ADA_USER, ADA_PASS, BOB_USER, BOB_PASS];

function members(): Row[] {
  return [
    { workspace_id: WS, user_id: ADA, role: "member" },
    { workspace_id: WS, user_id: BOB, role: "member" },
    { workspace_id: WS, user_id: CAT, role: "viewer" },
    { workspace_id: WS, user_id: ADMIN, role: "admin" },
    { workspace_id: OTHER_WS, user_id: STRANGER, role: "admin" },
  ];
}

function agents(): Row[] {
  return [
    { id: AGENT, workspace_id: WS, deleted_at: null },
    { id: OTHER_AGENT, workspace_id: OTHER_WS, deleted_at: null },
    { id: "agent-trashed", workspace_id: WS, deleted_at: "2026-10-01T00:00:00.000Z" },
  ];
}

type Intercept = (ctx: QueryContext) => QueryResult | undefined;

function world(credentials: Row[] = [], intercept?: Intercept) {
  const mem = memoryDb(
    { agents: agents(), workspace_members: members(), browser_credentials: credentials },
    intercept,
  );
  const deps: Partial<CredentialDeps> = {
    db: mem.db as unknown as SupabaseClient,
    now: () => NOW,
  };
  return { ...mem, deps };
}

async function row(over: Partial<Row> & { username: string; password: string }): Promise<Row> {
  const { username, password, ...rest } = over;
  return {
    id: "cred-x",
    workspace_id: WS,
    agent_id: AGENT,
    user_id: ADA,
    scope: "owner",
    site_host: "linkedin.com",
    label: "LinkedIn",
    username_ciphertext: await encryptSecret(username, KEY),
    password_ciphertext: await encryptSecret(password, KEY),
    created_at: "2026-10-01T00:00:00.000Z",
    last_used_at: null,
    ...rest,
  };
}

function adaSave(over: Partial<Parameters<typeof saveCredential>[1]> = {}) {
  return {
    workspaceId: WS,
    agentId: AGENT,
    userId: ADA,
    scope: "owner" as const,
    siteHost: "linkedin.com",
    label: "LinkedIn -- my account",
    username: ADA_USER,
    password: ADA_PASS,
    ...over,
  };
}

/**
 * Every console level, spied, for the whole file: nothing this module does may
 * hand a username or a password to a log line, on any path — including the
 * refusals and the failures, which are where a careless `console.error(input)`
 * usually lives.
 */
const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }> = [];

beforeEach(() => {
  spies = LEVELS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      const said = call
        .map((a) =>
          a instanceof Error ? `${a.message} ${a.stack}` : (JSON.stringify(a) ?? String(a)),
        )
        .join(" ");
      for (const secret of SECRETS) expect(said).not.toContain(secret);
    }
    spy.mockRestore();
  }
});

describe("siteHostOf (R25)", () => {
  it.each([
    ["linkedin.com", "linkedin.com"],
    ["LinkedIn.COM", "linkedin.com"],
    ["  www.linkedin.com  ", "linkedin.com"],
    ["https://www.LinkedIn.com:443/in/ada?x=1", "linkedin.com"],
    ["linkedin.com:8080", "linkedin.com"],
    ["accounts.linkedin.com", "accounts.linkedin.com"],
    ["www2.example.org", "www2.example.org"],
    ["https://münchen.de/", "xn--mnchen-3ya.de"],
  ])("normalises %j to %j", (input, host) => {
    expect(siteHostOf(input)).toBe(host);
  });

  it.each([
    "",
    "   ",
    "www.",
    "linkedin.com/login",
    "ada@linkedin.com",
    "not a host",
    "localhost",
    "https://",
    "javascript:alert(1)",
    ".linkedin.com",
    "linkedin..com",
  ])("refuses %j", (input) => {
    expect(siteHostOf(input)).toBeNull();
  });

  it("names the alias after the host, non-alphanumerics folded to _", () => {
    expect(credentialSlug("linkedin.com")).toBe("linkedin_com");
    expect(credentialSlug("my-shop.co.uk")).toBe("my_shop_co_uk");
  });
});

describe("credentialAliases (R31)", () => {
  // The provider's rule: "1–64 lowercase letters, digits, hyphens, or
  // underscores and start with a letter or digit".
  const ALIAS = /^[a-z0-9][a-z0-9_-]*$/;
  // 63 + 63 + 63 + 57 + 3, and four dots: 253, the longest host there is.
  const longest = (end: string) =>
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(56)}${end}`;

  it("keeps a short host's aliases exactly as they were", () => {
    expect(credentialAliases("linkedin.com")).toEqual({
      username: "linkedin_com_username",
      password: "linkedin_com_password",
    });
  });

  it("keeps a maximum-length host's aliases within 64 characters and the provider's shape", () => {
    const host = siteHostOf(longest("x.com"));
    expect(host).toHaveLength(253);
    const { username, password } = credentialAliases(host!);
    for (const alias of [username, password]) {
      expect(alias.length).toBeLessThanOrEqual(64);
      expect(alias).toMatch(ALIAS);
    }
    expect(username.endsWith("_username")).toBe(true);
    expect(password.endsWith("_password")).toBe(true);
  });

  it("keeps the longest full slug that fits unchanged, and shortens the first that does not", () => {
    const fits = `${"a".repeat(51)}.com`; // 55 characters: `_password` makes 64
    expect(credentialAliases(fits).password).toBe(`${"a".repeat(51)}_com_password`);
    const over = `${"a".repeat(52)}.com`;
    expect(credentialAliases(over).password.length).toBeLessThanOrEqual(64);
    expect(credentialAliases(over).password).not.toBe(`${"a".repeat(52)}_com_password`);
  });

  it("tells apart two long hosts that differ only at the end", () => {
    const one = credentialAliases(siteHostOf(longest("x.com"))!);
    const two = credentialAliases(siteHostOf(longest("y.com"))!);
    expect(one.username).not.toBe(two.username);
    expect(one.password).not.toBe(two.password);
  });

  it("is deterministic: the same host names the same aliases every time", () => {
    const host = siteHostOf(longest("x.com"))!;
    expect(credentialAliases(host)).toEqual(credentialAliases(host));
    expect(credentialAliases(`${host}`)).toEqual(credentialAliases(host.slice(0)));
  });

  it("starts with a letter or digit even when handed a host that does not", () => {
    expect(credentialSlug("_odd.example")).toMatch(ALIAS);
    expect(credentialAliases("-odd.example").username).toMatch(ALIAS);
  });

  it("is what credentialsFor names its bindings with", async () => {
    const host = siteHostOf(longest("x.com"))!;
    const w = world([
      await row({ id: "cred-1", site_host: host, username: ADA_USER, password: ADA_PASS }),
    ]);
    const found = await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host }, w.deps);
    const aliases = credentialAliases(host);
    expect(found?.bindings.map((b) => b.alias)).toEqual([aliases.username, aliases.password]);
    expect(found?.bindings[0].allowedDomains).toEqual([host]);
  });
});

describe("saveCredential", () => {
  it("encrypts both halves with the one envelope and stores nothing else in the clear", async () => {
    const w = world();
    const result = await saveCredential(
      ENV,
      adaSave({ siteHost: "https://www.LinkedIn.com/feed", label: "  LinkedIn -- my account " }),
      w.deps,
    );

    expect(result).toEqual({
      ok: true,
      credential: {
        id: expect.any(String),
        scope: "owner",
        siteHost: "linkedin.com",
        label: "LinkedIn -- my account",
        replaced: false,
      },
    });
    const [stored] = w.tables.browser_credentials;
    expect(stored).toMatchObject({
      workspace_id: WS,
      agent_id: AGENT,
      user_id: ADA,
      scope: "owner",
      site_host: "linkedin.com",
      label: "LinkedIn -- my account",
    });
    expect(String(stored.username_ciphertext)).toMatch(/^v1\./);
    expect(String(stored.password_ciphertext)).toMatch(/^v1\./);
    expect(await decryptSecret(String(stored.username_ciphertext), KEY)).toBe(ADA_USER);
    expect(await decryptSecret(String(stored.password_ciphertext), KEY)).toBe(ADA_PASS);
    for (const secret of SECRETS) expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it.each([
    ["an empty host", { siteHost: "   " }, "invalid_host"],
    ["a path for a host", { siteHost: "linkedin.com/login" }, "invalid_host"],
    ["an empty label", { label: "   " }, "invalid_label"],
    ["the username as the label", { label: ` ${ADA_USER.toUpperCase()} ` }, "label_is_username"],
    ["a label containing the username", { label: `LinkedIn (${ADA_USER})` }, "label_is_username"],
    ["the password as the label", { label: ` ${ADA_PASS.toUpperCase()} ` }, "label_is_password"],
    ["a label containing the password", { label: `LinkedIn (${ADA_PASS})` }, "label_is_password"],
    ["an empty username", { username: "  " }, "invalid_username"],
    ["an empty password", { password: "" }, "invalid_password"],
    ["a username over 2048 bytes", { username: "é".repeat(1025) }, "invalid_username"],
    ["a password over 2048 bytes", { password: "é".repeat(1025) }, "invalid_password"],
    ["a scope that is neither", { scope: "everyone" as "owner" }, "invalid_scope"],
  ])("refuses %s and writes nothing", async (_name, over, reason) => {
    const w = world();
    const result = await saveCredential(ENV, adaSave(over), w.deps);
    expect(result).toMatchObject({ ok: false, reason, message: expect.any(String) });
    expect(w.callsTo("browser_credentials")).toEqual([]);
  });

  it("measures the limit in UTF-8 bytes, not characters: 2048 ASCII bytes are fine", async () => {
    const w = world();
    const result = await saveCredential(
      ENV,
      adaSave({ username: "a".repeat(2048), password: "b".repeat(2048) }),
      w.deps,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["an agent of another workspace", { agentId: OTHER_AGENT }],
    ["an agent in the trash", { agentId: "agent-trashed" }],
    ["an agent that does not exist", { agentId: "agent-nope" }],
  ])("refuses %s, whatever the caller says the workspace is", async (_name, over) => {
    const w = world();
    const result = await saveCredential(ENV, adaSave(over), w.deps);
    expect(result).toMatchObject({ ok: false, reason: "agent_not_found" });
    expect(w.tables.browser_credentials).toEqual([]);
  });

  it("replaces the saver's own login in place: same row, new values", async () => {
    const w = world([await row({ id: "cred-1", username: "old@example.com", password: "old" })]);
    const result = await saveCredential(ENV, adaSave({ label: "LinkedIn -- renamed" }), w.deps);

    expect(result).toEqual({
      ok: true,
      credential: {
        id: "cred-1",
        scope: "owner",
        siteHost: "linkedin.com",
        label: "LinkedIn -- renamed",
        replaced: true,
      },
    });
    expect(w.tables.browser_credentials).toHaveLength(1);
    const [stored] = w.tables.browser_credentials;
    expect(stored.label).toBe("LinkedIn -- renamed");
    expect(await decryptSecret(String(stored.username_ciphertext), KEY)).toBe(ADA_USER);
    expect(await decryptSecret(String(stored.password_ciphertext), KEY)).toBe(ADA_PASS);
  });

  it("lets two members each keep a personal login for the same site", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const result = await saveCredential(
      ENV,
      adaSave({ userId: BOB, username: BOB_USER, password: BOB_PASS, label: "Bob's" }),
      w.deps,
    );
    expect(result).toMatchObject({ ok: true, credential: { replaced: false } });
    expect(w.tables.browser_credentials).toHaveLength(2);
    expect(w.tables.browser_credentials[0].label).toBe("LinkedIn");
  });

  it("keeps a person's own login and the shared one apart", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const result = await saveCredential(ENV, adaSave({ scope: "agent", label: "Team" }), w.deps);
    expect(result).toMatchObject({ ok: true, credential: { scope: "agent", replaced: false } });
    expect(w.tables.browser_credentials).toHaveLength(2);
  });

  it("refuses a second shared login for a site somebody else already shares", async () => {
    const w = world([
      await row({ id: "cred-1", scope: "agent", username: ADA_USER, password: ADA_PASS }),
    ]);
    const result = await saveCredential(
      ENV,
      adaSave({ userId: BOB, scope: "agent", username: BOB_USER, password: BOB_PASS, label: "B" }),
      w.deps,
    );
    expect(result).toEqual({
      ok: false,
      reason: "shared_exists",
      message: "a shared login for linkedin.com already exists",
    });
    expect(
      await decryptSecret(String(w.tables.browser_credentials[0].password_ciphertext), KEY),
    ).toBe(ADA_PASS);
  });

  it("lets the saver of the shared login replace it", async () => {
    const w = world([
      await row({ id: "cred-1", scope: "agent", username: "old@example.com", password: "old" }),
    ]);
    const result = await saveCredential(ENV, adaSave({ scope: "agent", label: "Team" }), w.deps);
    expect(result).toMatchObject({ ok: true, credential: { id: "cred-1", replaced: true } });
    expect(
      await decryptSecret(String(w.tables.browser_credentials[0].password_ciphertext), KEY),
    ).toBe(ADA_PASS);
  });

  it("maps the partial unique's 23505 to the same refusal when another save wins the race", async () => {
    const competitor = await row({
      id: "cred-race",
      scope: "agent",
      user_id: BOB,
      username: BOB_USER,
      password: BOB_PASS,
    });
    let raced = false;
    const w = world([], (ctx) => {
      if (ctx.table === "browser_credentials" && ctx.op === "insert" && !raced) {
        raced = true;
        w.tables.browser_credentials.push({ ...competitor });
        return {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "browser_credentials_agent_site_idx"',
          },
        };
      }
      return undefined;
    });
    const result = await saveCredential(ENV, adaSave({ scope: "agent", label: "Team" }), w.deps);
    expect(result).toEqual({
      ok: false,
      reason: "shared_exists",
      message: "a shared login for linkedin.com already exists",
    });
    expect(JSON.stringify(result)).not.toContain("duplicate key");
  });

  it("throws on any other database failure, carrying no value", async () => {
    const w = world([], (ctx) =>
      ctx.table === "browser_credentials" && ctx.op === "insert"
        ? { data: null, error: { code: "57014", message: "canceling statement" } }
        : undefined,
    );
    const failure = await saveCredential(ENV, adaSave(), w.deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    for (const secret of SECRETS) expect(String((failure as Error).message)).not.toContain(secret);
  });
});

describe("credentialsFor (R30)", () => {
  it("hands the caller's own login over as two bindings, scoped to the saved host", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "https://WWW.LinkedIn.com/feed" },
      w.deps,
    );

    expect(result).toEqual({
      id: "cred-1",
      label: "LinkedIn",
      scope: "owner",
      siteHost: "linkedin.com",
      // The names the task text uses (2.3): the bindings' own aliases, carried
      // beside them so nothing downstream has to tell the two halves apart.
      aliases: { username: "linkedin_com_username", password: "linkedin_com_password" },
      bindings: [
        {
          alias: "linkedin_com_username",
          source: { type: "inline", value: ADA_USER },
          allowedDomains: ["linkedin.com"],
        },
        {
          alias: "linkedin_com_password",
          source: { type: "inline", value: ADA_PASS },
          allowedDomains: ["linkedin.com"],
        },
      ],
    });
    expect(w.tables.browser_credentials[0].last_used_at).toBe(NOW.toISOString());
  });

  it("prefers the caller's own login to the shared one", async () => {
    const w = world([
      await row({
        id: "cred-shared",
        scope: "agent",
        user_id: BOB,
        username: BOB_USER,
        password: BOB_PASS,
      }),
      await row({ id: "cred-own", username: ADA_USER, password: ADA_PASS }),
    ]);
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(result?.id).toBe("cred-own");
    expect(result?.bindings[1].source.value).toBe(ADA_PASS);
    expect(
      w.tables.browser_credentials.find((r) => r.id === "cred-shared")?.last_used_at,
    ).toBeNull();
  });

  it("falls back to the shared login while its saver is still a member", async () => {
    const w = world([
      await row({
        id: "cred-shared",
        scope: "agent",
        user_id: BOB,
        label: "Team",
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(result).toMatchObject({ id: "cred-shared", label: "Team", scope: "agent" });
    expect(result?.bindings.map((b) => b.source.value)).toEqual([BOB_USER, BOB_PASS]);
  });

  it("stops using a shared login once its saver has left the workspace (R29), and keeps the row", async () => {
    const w = world([
      await row({
        id: "cred-shared",
        scope: "agent",
        user_id: "user-gone",
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(result).toBeNull();
    expect(w.tables.browser_credentials).toHaveLength(1);
    expect(w.tables.browser_credentials[0].last_used_at).toBeNull();
  });

  it("checks the saver's membership in the row's own workspace, not any workspace", async () => {
    const w = world([
      await row({
        id: "cred-shared",
        scope: "agent",
        user_id: STRANGER,
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    ).toBeNull();
  });

  it("never uses somebody else's own login", async () => {
    const w = world([
      await row({ id: "cred-bob", user_id: BOB, username: BOB_USER, password: BOB_PASS }),
    ]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    ).toBeNull();
  });

  it("never uses another agent's login", async () => {
    const w = world([
      await row({ id: "cred-1", agent_id: OTHER_AGENT, username: ADA_USER, password: ADA_PASS }),
    ]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    ).toBeNull();
  });

  it("answers nothing for a host that is not one", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "not a host" }, w.deps),
    ).toBeNull();
  });

  it("still answers when recording last use fails", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })], (ctx) =>
      ctx.table === "browser_credentials" && ctx.op === "update"
        ? { data: null, error: { code: "57014", message: "canceling statement" } }
        : undefined,
    );
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(result?.id).toBe("cred-1");
  });

  it("answers nothing for a row that will not decrypt, and logs only its id", async () => {
    const tampered = await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS });
    tampered.password_ciphertext = await encryptSecret(
      ADA_PASS,
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    );
    const w = world([tampered]);
    const result = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(result).toBeNull();
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((c) => JSON.stringify(c))
      .join(" ");
    expect(logged).toContain("cred-1");
    expect(logged).not.toContain(String(tampered.password_ciphertext));
  });
});

/**
 * Ruling R37: a wall on `accounts.linkedin.com` and a login saved for
 * `linkedin.com` are the same site — the provider types a binding on its host
 * "and its subdomains" — so with no exact match the pick walks up to a saved
 * parent, the longest first. Never down: a login saved for
 * `accounts.example.com` is not offered on `example.com`. And `allowedDomains`
 * stays the row's own host, never the one asked about.
 */
describe("credentialsFor on a subdomain (R37)", () => {
  it("falls back to a login saved for a parent host, typed only on that host", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "accounts.linkedin.com" },
      w.deps,
    );
    expect(login?.id).toBe("cred-1");
    expect(login?.siteHost).toBe("linkedin.com");
    expect(login?.bindings.map((b) => b.allowedDomains)).toEqual([
      ["linkedin.com"],
      ["linkedin.com"],
    ]);
  });

  it("never uses a login saved for a subdomain on its parent", async () => {
    const w = world([
      await row({
        id: "cred-1",
        site_host: "accounts.example.com",
        username: ADA_USER,
        password: ADA_PASS,
      }),
    ]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "example.com" }, w.deps),
    ).toBeNull();
  });

  it("never matches a host that merely ends in the same letters", async () => {
    const w = world([
      await row({ id: "cred-1", site_host: "inkedin.com", username: ADA_USER, password: ADA_PASS }),
    ]);
    expect(
      await credentialsFor(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    ).toBeNull();
  });

  it("prefers an exact match, even a shared one, to the caller's own login on a parent", async () => {
    const w = world([
      await row({ id: "cred-own-parent", username: ADA_USER, password: ADA_PASS }),
      await row({
        id: "cred-shared-exact",
        scope: "agent",
        user_id: BOB,
        site_host: "accounts.linkedin.com",
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "accounts.linkedin.com" },
      w.deps,
    );
    expect(login?.id).toBe("cred-shared-exact");
  });

  it("prefers the longest saved parent", async () => {
    const w = world([
      await row({
        id: "cred-far",
        site_host: "example.com",
        username: ADA_USER,
        password: ADA_PASS,
      }),
      await row({
        id: "cred-near",
        site_host: "b.example.com",
        username: ADA_USER,
        password: ADA_PASS,
      }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "a.b.example.com" },
      w.deps,
    );
    expect(login?.id).toBe("cred-near");
    expect(login?.bindings[0].allowedDomains).toEqual(["b.example.com"]);
  });

  it("passes over a parent's shared login whose saver has left, to the next one up", async () => {
    const w = world([
      await row({
        id: "cred-gone",
        scope: "agent",
        user_id: "user-gone",
        site_host: "b.example.com",
        username: BOB_USER,
        password: BOB_PASS,
      }),
      await row({
        id: "cred-own",
        site_host: "example.com",
        username: ADA_USER,
        password: ADA_PASS,
      }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "a.b.example.com" },
      w.deps,
    );
    expect(login?.id).toBe("cred-own");
  });

  it("names the same parent login on the card, without opening it", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const named = await savedLogin(
      ENV,
      { agentId: AGENT, userId: ADA, host: "accounts.linkedin.com" },
      w.deps,
    );
    expect(named).toEqual({
      id: "cred-1",
      label: "LinkedIn",
      scope: "owner",
      siteHost: "linkedin.com",
    });
    expect(w.tables.browser_credentials[0].last_used_at).toBeNull();
  });

  it("honours a preferred row saved for a parent of the host asked about", async () => {
    const w = world([
      await row({
        id: "cred-sub-own",
        site_host: "accounts.linkedin.com",
        username: ADA_USER,
        password: ADA_PASS,
      }),
      await row({
        id: "cred-parent-shared",
        scope: "agent",
        user_id: BOB,
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const login = await credentialsFor(
      ENV,
      {
        agentId: AGENT,
        userId: ADA,
        host: "accounts.linkedin.com",
        prefer: "cred-parent-shared",
      },
      w.deps,
    );
    expect(login?.id).toBe("cred-parent-shared");
    expect(login?.bindings[0].allowedDomains).toEqual(["linkedin.com"]);
  });
});

/**
 * R35: the hand-back after a save names the row the save returned. Without
 * it, a run that carried the caller's personal login, followed by "Save for
 * everyone", would bind the personal row again — `pick` prefers it — and
 * spend the one free retry on the login that just failed. The preference is
 * honoured only for a row the caller is entitled to on this agent and site;
 * anything else falls back to the ordinary pick, and is never bound.
 */
describe("credentialsFor with a preferred row (R35)", () => {
  const NEW_USER = "ada.shared@example.com";
  const NEW_PASS = "fresh-shared-password-1";

  it("binds the shared login just saved, over the caller's own that failed", async () => {
    const w = world([await row({ id: "cred-ada-own", username: ADA_USER, password: ADA_PASS })]);
    const saved = await saveCredential(
      ENV,
      adaSave({
        scope: "agent",
        label: "LinkedIn — shared",
        username: NEW_USER,
        password: NEW_PASS,
      }),
      w.deps,
    );
    expect(saved.ok).toBe(true);
    const sharedId = saved.ok ? saved.credential.id : "";
    expect(sharedId).not.toBe("cred-ada-own");

    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com", prefer: sharedId },
      w.deps,
    );

    expect(login?.id).toBe(sharedId);
    expect(login?.scope).toBe("agent");
    expect(login?.bindings.map((b) => b.source.value)).toEqual([NEW_USER, NEW_PASS]);
    // From the row, never from anything the caller sent.
    expect(login?.bindings.every((b) => b.allowedDomains?.join() === "linkedin.com")).toBe(true);
  });

  it("binds a colleague's shared login when it is the one named", async () => {
    const w = world([
      await row({ id: "cred-ada-own", username: ADA_USER, password: ADA_PASS }),
      await row({
        id: "cred-bob-team",
        scope: "agent",
        user_id: BOB,
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com", prefer: "cred-bob-team" },
      w.deps,
    );
    expect(login?.id).toBe("cred-bob-team");
  });

  it.each([
    ["another member's personal login", { id: "cred-x", user_id: BOB }],
    ["a shared login of another agent", { id: "cred-x", scope: "agent", agent_id: OTHER_AGENT }],
    ["a login for another site", { id: "cred-x", scope: "agent", site_host: "github.com" }],
    ["a shared login whose saver has left", { id: "cred-x", scope: "agent", user_id: "user-gone" }],
  ])("ignores %s and falls back to the ordinary pick", async (_label, over) => {
    const w = world([
      await row({ id: "cred-ada-own", username: ADA_USER, password: ADA_PASS }),
      await row({ ...over, username: BOB_USER, password: BOB_PASS }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com", prefer: "cred-x" },
      w.deps,
    );

    expect(login?.id).toBe("cred-ada-own");
    expect(JSON.stringify(login)).not.toContain(BOB_PASS);
  });

  it("answers nothing, rather than the named row, when the caller may use none", async () => {
    const w = world([
      await row({ id: "cred-bob-own", user_id: BOB, username: BOB_USER, password: BOB_PASS }),
    ]);
    const login = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com", prefer: "cred-bob-own" },
      w.deps,
    );
    expect(login).toBeNull();
  });
});

describe("hasSavedCredential (R27)", () => {
  it("answers a bare boolean, by the same rules the binding uses", async () => {
    const w = world([
      await row({ id: "cred-own", username: ADA_USER, password: ADA_PASS }),
      await row({
        id: "cred-gone",
        site_host: "example.com",
        scope: "agent",
        user_id: "user-gone",
        username: BOB_USER,
        password: BOB_PASS,
      }),
      await row({
        id: "cred-team",
        site_host: "shop.com",
        scope: "agent",
        user_id: BOB,
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const ask = (userId: string, host: string) =>
      hasSavedCredential(ENV, { agentId: AGENT, userId, host }, w.deps);

    expect(await ask(ADA, "www.linkedin.com")).toBe(true);
    expect(await ask(BOB, "linkedin.com")).toBe(false);
    expect(await ask(ADA, "example.com")).toBe(false);
    expect(await ask(CAT, "shop.com")).toBe(true);
    expect(await ask(ADA, "nowhere.com")).toBe(false);
    expect(await ask(ADA, "")).toBe(false);
    // Nothing decrypted, nothing marked as used: it is a question, not a use.
    expect(w.callsTo("browser_credentials").every((c) => c.op === "select")).toBe(true);
    for (const call of w.callsTo("browser_credentials")) {
      expect(call.columns ?? "").not.toContain("ciphertext");
    }
  });
});

describe("savedLogin (2.3's approval card)", () => {
  it("names the login a run would be given — id, label, scope, host — without decrypting or using it", async () => {
    const w = world([
      await row({
        id: "cred-own",
        label: "LinkedIn — mine",
        username: ADA_USER,
        password: ADA_PASS,
      }),
      await row({
        id: "cred-team",
        site_host: "shop.com",
        scope: "agent",
        user_id: BOB,
        label: "Shop — team",
        username: BOB_USER,
        password: BOB_PASS,
      }),
      await row({
        id: "cred-gone",
        site_host: "example.com",
        scope: "agent",
        user_id: "user-gone",
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
    const ask = (userId: string, host: string) =>
      savedLogin(ENV, { agentId: AGENT, userId, host }, w.deps);

    expect(await ask(ADA, "https://www.linkedin.com/feed")).toEqual({
      id: "cred-own",
      label: "LinkedIn — mine",
      scope: "owner",
      siteHost: "linkedin.com",
    });
    expect(await ask(CAT, "shop.com")).toEqual({
      id: "cred-team",
      label: "Shop — team",
      scope: "agent",
      siteHost: "shop.com",
    });
    // The same rules as the binding: not somebody else's own, not a departed saver's.
    expect(await ask(BOB, "linkedin.com")).toBeNull();
    expect(await ask(ADA, "example.com")).toBeNull();
    expect(await ask(ADA, "not a host")).toBeNull();

    // A card somebody may decline: nothing decrypted, nothing marked as used.
    expect(w.callsTo("browser_credentials").every((c) => c.op === "select")).toBe(true);
    for (const call of w.callsTo("browser_credentials")) {
      expect(call.columns ?? "").not.toContain("ciphertext");
    }
    expect(w.tables.browser_credentials.every((r) => r.last_used_at === null)).toBe(true);
  });
});

describe("credentialCoversHost (R32, for deliver)", () => {
  it("answers whether the login a run carried is typed on the host that walled it", async () => {
    const w = world([await row({ id: "cred-1", username: ADA_USER, password: ADA_PASS })]);
    const covers = (host: string, credentialId = "cred-1") =>
      credentialCoversHost(ENV, { credentialId, host }, w.deps);

    expect(await covers("linkedin.com")).toBe(true);
    expect(await covers("https://WWW.LinkedIn.com/login")).toBe(true);
    // The provider's rule: a host covers its subdomains, so the login was
    // there to be typed on the site's own sign-in subdomain.
    expect(await covers("accounts.linkedin.com")).toBe(true);
    // A different site, a look-alike, and nothing at all.
    expect(await covers("accounts.google.com")).toBe(false);
    expect(await covers("notlinkedin.com")).toBe(false);
    expect(await covers("not a host")).toBe(false);
    // A login forgotten since the run: there is nothing left to blame.
    expect(await covers("linkedin.com", "cred-gone")).toBe(false);

    // A question, not a use: the host column and nothing else.
    for (const call of w.callsTo("browser_credentials")) {
      expect(call.op).toBe("select");
      expect(call.columns ?? "").not.toContain("ciphertext");
    }
    expect(w.tables.browser_credentials[0].last_used_at).toBeNull();
  });

  it("throws on a read error, carrying no value, for deliver to catch", async () => {
    const w = world([], (ctx) =>
      ctx.table === "browser_credentials"
        ? { data: null, error: { code: "57014", message: "canceling statement" } }
        : undefined,
    );
    await expect(
      credentialCoversHost(ENV, { credentialId: "cred-1", host: "linkedin.com" }, w.deps),
    ).rejects.toThrow(/57014/);
  });
});

describe("tasksThatCarriedALogin (R32, for the sign-in card)", () => {
  function tasks(): Row[] {
    return [
      { id: "bt-carried", user_id: ADA, credential_id: "cred-1" },
      { id: "bt-plain", user_id: ADA, credential_id: null },
      { id: "bt-forgotten", user_id: ADA, credential_id: null },
      // Bob's task, carrying a login: never answered to Ada, whatever she names.
      { id: "bt-bob", user_id: BOB, credential_id: "cred-2" },
    ];
  }

  it("names which of the caller's tasks carried a saved login, and never which login", async () => {
    const mem = memoryDb({ browser_tasks: tasks() });
    const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW };

    const carried = await tasksThatCarriedALogin(
      ENV,
      { userId: ADA, taskIds: ["bt-carried", "bt-plain", "bt-forgotten", "bt-bob"] },
      deps,
    );

    expect([...carried]).toEqual(["bt-carried"]);
    const [read] = mem.callsTo("browser_tasks");
    expect(read.filters).toContainEqual({ column: "user_id", value: ADA, kind: "eq" });
    expect(read.columns).not.toContain("ciphertext");
  });

  it("asks nothing when there is nothing to ask about", async () => {
    const mem = memoryDb({ browser_tasks: tasks() });
    const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW };

    expect((await tasksThatCarriedALogin(ENV, { userId: ADA, taskIds: [] }, deps)).size).toBe(0);
    expect(mem.callsTo("browser_tasks")).toEqual([]);
  });

  it("throws on a read error, carrying no value, for the route to catch", async () => {
    const mem = memoryDb({ browser_tasks: tasks() }, () => ({
      data: null,
      error: { code: "57014", message: "canceling statement" },
    }));
    const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW };

    await expect(
      tasksThatCarriedALogin(ENV, { userId: ADA, taskIds: ["bt-carried"] }, deps),
    ).rejects.toThrow(/57014/);
  });
});

describe("forgetCredential (R29)", () => {
  async function seeded() {
    return world([
      await row({ id: "cred-ada-own", username: ADA_USER, password: ADA_PASS }),
      await row({ id: "cred-ada-team", scope: "agent", username: ADA_USER, password: ADA_PASS }),
      await row({ id: "cred-bob-own", user_id: BOB, username: BOB_USER, password: BOB_PASS }),
      await row({
        id: "cred-gone-team",
        scope: "agent",
        site_host: "shop.com",
        user_id: "user-gone",
        username: BOB_USER,
        password: BOB_PASS,
      }),
    ]);
  }
  const ids = (w: Awaited<ReturnType<typeof seeded>>) =>
    w.tables.browser_credentials.map((r) => r.id);

  it("lets the saver delete their own login, in either scope", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-own", userId: ADA }, w.deps),
    ).toEqual({ ok: true });
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-team", userId: ADA }, w.deps),
    ).toEqual({ ok: true });
    expect(ids(w)).toEqual(["cred-bob-own", "cred-gone-team"]);
  });

  it("lets a saver who has left the workspace still delete their own login", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-gone-team", userId: "user-gone" }, w.deps),
    ).toEqual({ ok: true });
    expect(ids(w)).not.toContain("cred-gone-team");
  });

  it("lets a workspace admin delete a shared login, including a departed saver's", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-gone-team", userId: ADMIN }, w.deps),
    ).toEqual({ ok: true });
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-team", userId: ADMIN }, w.deps),
    ).toEqual({ ok: true });
    expect(ids(w)).toEqual(["cred-ada-own", "cred-bob-own"]);
  });

  it("does not let an admin delete somebody's own login, and does not say it exists", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-bob-own", userId: ADMIN }, w.deps),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(ids(w)).toContain("cred-bob-own");
  });

  it("answers a colleague's attempt on somebody's own login as not_found, not forbidden", async () => {
    // `forbidden` would tell Ada that Bob keeps a personal login here, which
    // 0079's read policy hides from her.
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-bob-own", userId: ADA }, w.deps),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(ids(w)).toContain("cred-bob-own");
  });

  it("refuses a member who is neither the saver nor an admin a shared login they can see", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-team", userId: BOB }, w.deps),
    ).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-team", userId: CAT }, w.deps),
    ).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(ids(w)).toContain("cred-ada-team");
  });

  it("answers not_found to an admin of another workspace, a stranger, and a missing id", async () => {
    const w = await seeded();
    expect(
      await forgetCredential(ENV, { credentialId: "cred-ada-team", userId: STRANGER }, w.deps),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await forgetCredential(ENV, { credentialId: "cred-nope", userId: ADA }, w.deps)).toEqual(
      {
        ok: false,
        reason: "not_found",
      },
    );
    expect(w.tables.browser_credentials).toHaveLength(4);
  });
});

describe("no value leaves except through the bindings", () => {
  it("carries no username or password in any return but credentialsFor's SecretBinding[]", async () => {
    const w = world();
    const returns: unknown[] = [];

    const saved = await saveCredential(ENV, adaSave(), w.deps);
    returns.push(saved);
    returns.push(
      await saveCredential(
        ENV,
        adaSave({
          userId: BOB,
          scope: "agent",
          username: BOB_USER,
          password: BOB_PASS,
          label: "Team",
        }),
        w.deps,
      ),
    );
    returns.push(
      await saveCredential(
        ENV,
        adaSave({ scope: "agent", label: "Mine", username: ADA_USER, password: ADA_PASS }),
        w.deps,
      ),
    );
    returns.push(await saveCredential(ENV, adaSave({ label: ADA_USER }), w.deps));
    returns.push(
      await saveCredential(ENV, adaSave({ password: "é".repeat(2000) + ADA_PASS }), w.deps),
    );
    returns.push(
      await hasSavedCredential(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    );
    returns.push(
      await savedLogin(ENV, { agentId: AGENT, userId: ADA, host: "linkedin.com" }, w.deps),
    );

    const found = await credentialsFor(
      ENV,
      { agentId: AGENT, userId: ADA, host: "linkedin.com" },
      w.deps,
    );
    expect(found?.bindings.map((b) => b.source.value)).toEqual([ADA_USER, ADA_PASS]);
    const { bindings: _bindings, ...outsideTheBindings } = found!;
    returns.push(outsideTheBindings);
    returns.push(
      await credentialsFor(ENV, { agentId: AGENT, userId: CAT, host: "nowhere.com" }, w.deps),
    );

    const id = saved.ok ? saved.credential.id : "";
    returns.push(await forgetCredential(ENV, { credentialId: id, userId: BOB }, w.deps));
    returns.push(await forgetCredential(ENV, { credentialId: id, userId: ADA }, w.deps));

    for (const value of returns) {
      for (const secret of SECRETS) expect(JSON.stringify(value) ?? "").not.toContain(secret);
    }
  });
});
