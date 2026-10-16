/**
 * Two-step sign-in, enforced by Postgres (0108).
 *
 * The sign-in page asking for a code is courtesy. What this file proves is the
 * part that is not: a session that gave only a password, for an account with
 * an authenticator, gets nothing out of PostgREST — no table, no RPC, not even
 * the `security definer` ones that read past policies — while every account
 * without an authenticator is exactly as it was.
 *
 * Real GoTrue, real factors, real codes: the sessions here are the ones a
 * browser would hold.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  enrollTotp,
  passwordOnlyClient,
  sql,
  type TestUser,
} from "./harness";

/** An account that never turned two-step on. */
let plain: TestUser;
/** An account with an authenticator; `guarded.db` has given its code. */
let guarded: TestUser;
/** The same account, signed in with its password alone. */
let halfway: SupabaseClient;

beforeAll(async () => {
  plain = await createTestUser("second-factor-plain");
  guarded = await createTestUser("second-factor-guarded");
  await enrollTotp(guarded);
  halfway = await passwordOnlyClient(guarded);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

const REFUSED = "second factor required";

describe("a session that has not given its code", () => {
  it("is aal1, with aal2 owed — the state the sign-in page sends to /two-factor", async () => {
    const { data } = await halfway.auth.mfa.getAuthenticatorAssuranceLevel();

    expect(data?.currentLevel).toBe("aal1");
    expect(data?.nextLevel).toBe("aal2");
  });

  it("reads nothing, not even its own profile", async () => {
    const { data, error } = await halfway.from("profiles").select("id").eq("id", guarded.id);

    expect(error?.message).toBe(REFUSED);
    // What worker/src/middleware/auth.ts reads to tell "owes a code" from "the
    // database could not be asked".
    expect(error?.code).toBe("PT403");
    expect(data).toBeNull();
  });

  it("writes nothing", async () => {
    const { error } = await halfway
      .from("profiles")
      .update({ name: "taken over" })
      .eq("id", guarded.id);

    expect(error?.message).toBe(REFUSED);
  });

  // The reason the rule is a pre-request hook and not a policy per table: a
  // definer function reads past policies, so a policy-only rule would leave it
  // answering.
  it("cannot reach a security definer RPC either", async () => {
    const { error } = await halfway.rpc("workspace_usage_all", {
      p_workspace_id: guarded.workspaceId,
    });

    expect(error?.message).toBe(REFUSED);
  });

  it("cannot change the account's password", async () => {
    const { error } = await halfway.auth.updateUser({ password: crypto.randomUUID() });

    expect(error).not.toBeNull();
  });
});

describe("a session that has given its code", () => {
  it("is aal2", async () => {
    const { data } = await guarded.db.auth.mfa.getAuthenticatorAssuranceLevel();

    expect(data?.currentLevel).toBe("aal2");
  });

  it("reads and writes as before", async () => {
    const { data, error } = await guarded.db.from("profiles").select("id").eq("id", guarded.id);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: guarded.id }]);

    const { error: rpcError } = await guarded.db.rpc("workspace_usage_all", {
      p_workspace_id: guarded.workspaceId,
    });
    expect(rpcError).toBeNull();
  });
});

describe("an account without an authenticator", () => {
  it("is untouched, at aal1, by somebody else having one", async () => {
    const { data: level } = await plain.db.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(level?.currentLevel).toBe("aal1");

    const { data, error } = await plain.db.from("profiles").select("id").eq("id", plain.id);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: plain.id }]);
  });
});

describe("the hook itself", () => {
  const ROLLBACK = Symbol("rollback");

  /** Runs the hook under `claims`, the way PostgREST runs it before a request. */
  async function hookUnder(claims: Record<string, string>): Promise<string | null> {
    let outcome: string | null = null;
    try {
      await sql().begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`set local role ${tx(claims.role === "anon" ? "anon" : "authenticated")}`;
        try {
          await tx`select public.require_second_factor()`;
        } catch (e) {
          outcome = (e as Error).message;
        }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return outcome;
  }

  // A token minted for an API key (worker/src/lib/api-keys.ts) claims aal2,
  // so a key keeps working for an owner who turns two-step on.
  it("lets an aal2 claim through for an account with an authenticator", async () => {
    await expect(
      hookUnder({ sub: guarded.id, role: "authenticated", aal: "aal2" }),
    ).resolves.toBeNull();
  });

  it("refuses an aal1 claim, or none, for that account", async () => {
    await expect(hookUnder({ sub: guarded.id, role: "authenticated", aal: "aal1" })).resolves.toBe(
      REFUSED,
    );
    await expect(hookUnder({ sub: guarded.id, role: "authenticated" })).resolves.toBe(REFUSED);
  });

  it("has nothing to say to the anonymous", async () => {
    await expect(hookUnder({ role: "anon" })).resolves.toBeNull();
  });
});
