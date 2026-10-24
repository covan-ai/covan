import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb } from "../test-support/memory-db";
import { loadTeamContext } from "./memory";

// Invented stand-ins throughout. The email column is on the profile rows on
// purpose: the loader must not select it, and a fake that applied the column
// list would hide that, so the test reads what was asked for instead.
const ADA = "00000000-0000-4000-8000-00000000ada0";
const GRACE = "00000000-0000-4000-8000-0000000009ac";
const LIN = "00000000-0000-4000-8000-000000000e1f";
const OUTSIDER = "00000000-0000-4000-8000-0000000000ff";

const seed = () => ({
  workspaces: [
    { id: "w1", name: "Acme" },
    { id: "w2", name: "Other Co" },
  ],
  workspace_members: [
    { workspace_id: "w1", user_id: ADA, role: "admin" },
    { workspace_id: "w1", user_id: GRACE, role: "member" },
    { workspace_id: "w1", user_id: LIN, role: "viewer" },
    { workspace_id: "w2", user_id: OUTSIDER, role: "admin" },
  ],
  profiles: [
    {
      id: ADA,
      name: "Ada Test",
      bio: "Runs support",
      timezone: "Europe/Istanbul",
      email: "ada@acme.test",
    },
    { id: GRACE, name: "Grace Test", bio: null, timezone: null, email: "grace@acme.test" },
    // LIN has no profile row at all.
    { id: OUTSIDER, name: "Not Ours", bio: "Elsewhere", timezone: null, email: "x@other.test" },
  ],
});

describe("loadTeamContext", () => {
  it("reads the workspace name, the members and their profiles through the given client", async () => {
    const { db, calls } = memoryDb(seed());
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
    });

    expect(out?.workspaceName).toBe("Acme");
    expect(out?.callerId).toBe(ADA);
    const people = [...(out?.people ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    expect(people).toEqual(
      [
        {
          id: ADA,
          name: "Ada Test",
          bio: "Runs support",
          timezone: "Europe/Istanbul",
          role: "admin",
        },
        { id: GRACE, name: "Grace Test", bio: null, timezone: null, role: "member" },
        // A member whose profile has not been filled in is still on the team.
        { id: LIN, name: null, bio: null, timezone: null, role: "viewer" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    expect(calls.map((c) => c.table).sort()).toEqual([
      "profiles",
      "workspace_members",
      "workspaces",
    ]);
  });

  it("selects named profile columns, never email and never *, and scopes every read itself", async () => {
    const { db, callsTo } = memoryDb(seed());
    await loadTeamContext(db as unknown as SupabaseClient, { workspaceId: "w1", callerId: null });

    expect(callsTo("profiles")[0]!.columns).toBe("id, name, bio, timezone");
    // A service-role client sees every row, so nothing may lean on RLS to scope.
    const eq = (table: string) =>
      callsTo(table)[0]!
        .filters.filter((f) => f.kind === "eq")
        .map((f) => [f.column, f.value]);
    expect(eq("workspaces")).toContainEqual(["id", "w1"]);
    expect(eq("workspace_members")).toContainEqual(["workspace_id", "w1"]);
    const inFilter = callsTo("profiles")[0]!.filters.find((f) => f.kind === "in");
    expect(inFilter?.column).toBe("id");
    expect([...(inFilter?.value as string[])].sort()).toEqual([ADA, GRACE, LIN].sort());
  });

  it("does not return people from another workspace", async () => {
    const { db } = memoryDb(seed());
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w2",
      callerId: null,
    });
    expect(out?.workspaceName).toBe("Other Co");
    expect(out?.people.map((p) => p.id)).toEqual([OUTSIDER]);
  });

  it("returns empty note lists and reads no notes table", async () => {
    // The notes arrive with `memory_notes` in a later change; until then the
    // loader reads nothing it could not have.
    const { db, callsTo } = memoryDb(seed());
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
    });
    expect(out?.teamNotes).toEqual([]);
    expect(out?.personNotes).toEqual([]);
    expect(callsTo("memory_notes")).toEqual([]);
  });

  it("answers null when the workspace is not there", async () => {
    const { db } = memoryDb(seed());
    expect(
      await loadTeamContext(db as unknown as SupabaseClient, {
        workspaceId: "nope",
        callerId: null,
      }),
    ).toBeNull();
  });

  for (const failing of ["workspaces", "workspace_members", "profiles"]) {
    it(`answers null when the ${failing} read fails, and logs it`, async () => {
      // A turn must not fail because the roster failed.
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { db } = memoryDb(seed(), (ctx) =>
        ctx.table === failing ? { data: null, error: { message: "down" } } : undefined,
      );
      const out = await loadTeamContext(db as unknown as SupabaseClient, {
        workspaceId: "w1",
        callerId: ADA,
      });
      expect(out).toBeNull();
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  }

  it("answers null, and logs, when the client throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from() {
        throw new Error("socket closed");
      },
    } as unknown as SupabaseClient;
    expect(await loadTeamContext(db, { workspaceId: "w1", callerId: null })).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
