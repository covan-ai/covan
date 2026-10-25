import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb } from "../test-support/memory-db";
import { loadTeamContext } from "./memory";
import { MAX_PERSON_NOTES, MAX_TEAM_NOTES } from "./team-block";

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
  memory_notes: [] as Record<string, unknown>[],
});

const note = (
  id: string,
  workspace_id: string,
  created_by: string,
  scope: "owner" | "workspace",
  text: string,
  created_at: string,
) => ({ id, workspace_id, created_by, about: created_by, scope, text, created_at });

// Eight notes: the team's shared ones in w1, two people's private ones in w1,
// and a shared and a private note in another workspace.
const notes = () => [
  note("n1", "w1", GRACE, "workspace", "Planning is on Mondays.", "2026-10-01T10:00:00Z"),
  note("n2", "w1", ADA, "workspace", "A spec is the one-page brief.", "2026-10-03T10:00:00Z"),
  note("n3", "w1", ADA, "owner", "Prefers tables.", "2026-10-02T10:00:00Z"),
  note("n4", "w1", ADA, "owner", "Answers in Turkish.", "2026-10-04T10:00:00Z"),
  note("n5", "w1", GRACE, "owner", "Hates long emails.", "2026-10-05T10:00:00Z"),
  note("n6", "w2", OUTSIDER, "workspace", "Elsewhere shared.", "2026-10-06T10:00:00Z"),
  note("n7", "w2", ADA, "owner", "Elsewhere private.", "2026-10-07T10:00:00Z"),
  note("n8", "w1", GRACE, "workspace", "Reviews ship on Fridays.", "2026-10-06T10:00:00Z"),
];

describe("loadTeamContext", () => {
  it("reads the workspace name, the members and their profiles through the given client", async () => {
    const { db, calls } = memoryDb(seed());
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
      personNotes: true,
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
      "memory_notes",
      "memory_notes",
      "profiles",
      "workspace_members",
      "workspaces",
    ]);
  });

  it("selects named profile columns, never email and never *, and scopes every read itself", async () => {
    const { db, callsTo } = memoryDb(seed());
    await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: null,
      personNotes: true,
    });

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
      personNotes: true,
    });
    expect(out?.workspaceName).toBe("Other Co");
    expect(out?.people.map((p) => p.id)).toEqual([OUTSIDER]);
  });

  it("reads the team's shared notes and the caller's own private ones", async () => {
    const { db, callsTo } = memoryDb({ ...seed(), memory_notes: notes() });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
      personNotes: true,
    });
    // Newest first, this workspace only, and only the caller's private ones.
    expect(out?.teamNotes).toEqual([
      "Reviews ship on Fridays.",
      "A spec is the one-page brief.",
      "Planning is on Mondays.",
    ]);
    expect(out?.personNotes).toEqual(["Answers in Turkish.", "Prefers tables."]);

    const reads = callsTo("memory_notes");
    expect(reads).toHaveLength(2);
    const shape = (r: (typeof reads)[number]) => ({
      columns: r.columns,
      eq: r.filters.filter((f) => f.kind === "eq").map((f) => [f.column, f.value]),
      order: r.order,
      limit: r.limit,
    });
    const team = reads.find((r) =>
      r.filters.some((f) => f.column === "scope" && f.value === "workspace"),
    )!;
    const person = reads.find((r) =>
      r.filters.some((f) => f.column === "scope" && f.value === "owner"),
    )!;
    expect(shape(team)).toEqual({
      columns: "text",
      eq: [
        ["workspace_id", "w1"],
        ["scope", "workspace"],
      ],
      order: [
        { column: "created_at", ascending: false },
        { column: "id", ascending: false },
      ],
      limit: MAX_TEAM_NOTES,
    });
    expect(shape(person)).toEqual({
      columns: "text",
      eq: [
        ["workspace_id", "w1"],
        ["created_by", ADA],
        ["scope", "owner"],
      ],
      order: [
        { column: "created_at", ascending: false },
        { column: "id", ascending: false },
      ],
      limit: MAX_PERSON_NOTES,
    });
    expect(MAX_TEAM_NOTES).toBe(40);
    expect(MAX_PERSON_NOTES).toBe(25);
  });

  it("breaks a tie on created_at by id, newest id first, so the same rows always come back alike", async () => {
    const same = "2026-10-01T10:00:00Z";
    const { db } = memoryDb({
      ...seed(),
      memory_notes: [
        note("a", "w1", GRACE, "workspace", "first", same),
        note("c", "w1", GRACE, "workspace", "third", same),
        note("b", "w1", GRACE, "workspace", "second", same),
      ],
    });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: null,
      personNotes: true,
    });
    expect(out?.teamNotes).toEqual(["third", "second", "first"]);
  });

  it("reads no private notes when there is no caller", async () => {
    const { db, callsTo } = memoryDb({ ...seed(), memory_notes: notes() });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: null,
      personNotes: true,
    });
    expect(out?.personNotes).toEqual([]);
    expect(out?.teamNotes).toHaveLength(3);
    const reads = callsTo("memory_notes");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters.some((f) => f.column === "created_by")).toBe(false);
    expect(reads.some((r) => r.filters.some((f) => f.value === "owner"))).toBe(false);
  });

  it("reads no private notes when the surface is not private, caller or not", async () => {
    // A shared room is read by everyone in it, so the caller's own notes stay
    // out even though the caller is known and the notes exist. The roster and
    // the caller are unchanged.
    const { db, callsTo } = memoryDb({ ...seed(), memory_notes: notes() });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
      personNotes: false,
    });
    expect(out?.personNotes).toEqual([]);
    expect(out?.callerId).toBe(ADA);
    expect(out?.people.map((p) => p.id).sort()).toEqual([ADA, GRACE, LIN].sort());
    expect(out?.teamNotes).toHaveLength(3);
    const reads = callsTo("memory_notes");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters.some((f) => f.column === "created_by")).toBe(false);
    expect(reads.some((r) => r.filters.some((f) => f.value === "owner"))).toBe(false);
  });

  it("never asks for another person's private notes through a service-role client", async () => {
    // A service-role client sees every row, so the only thing keeping Grace's
    // private notes out of Ada's prefix is the filter.
    const { db, callsTo } = memoryDb({ ...seed(), memory_notes: notes() });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: GRACE,
      personNotes: true,
    });
    expect(out?.personNotes).toEqual(["Hates long emails."]);
    const createdBy = callsTo("memory_notes").flatMap((r) =>
      r.filters.filter((f) => f.column === "created_by").map((f) => f.value),
    );
    expect(createdBy).toEqual([GRACE]);
    // Nothing from the other workspace either.
    expect(out?.teamNotes).not.toContain("Elsewhere shared.");
  });

  for (const list of ["workspace", "owner"] as const) {
    it(`keeps the roster and the other list when the ${list} notes read fails, and logs it`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { db } = memoryDb({ ...seed(), memory_notes: notes() }, (ctx) =>
        ctx.table === "memory_notes" &&
        ctx.filters.some((f) => f.column === "scope" && f.value === list)
          ? { data: null, error: { message: "down" } }
          : undefined,
      );
      const out = await loadTeamContext(db as unknown as SupabaseClient, {
        workspaceId: "w1",
        callerId: ADA,
        personNotes: true,
      });
      expect(out?.workspaceName).toBe("Acme");
      expect(out?.people).toHaveLength(3);
      expect(out?.teamNotes).toEqual(
        list === "workspace"
          ? []
          : [
              "Reviews ship on Fridays.",
              "A spec is the one-page brief.",
              "Planning is on Mondays.",
            ],
      );
      expect(out?.personNotes).toEqual(
        list === "owner" ? [] : ["Answers in Turkish.", "Prefers tables."],
      );
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  }

  it("keeps the roster when a notes read throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = memoryDb({ ...seed(), memory_notes: notes() }, (ctx) => {
      if (ctx.table === "memory_notes") throw new Error("socket closed");
      return undefined;
    });
    const out = await loadTeamContext(db as unknown as SupabaseClient, {
      workspaceId: "w1",
      callerId: ADA,
      personNotes: true,
    });
    expect(out?.people).toHaveLength(3);
    expect(out?.teamNotes).toEqual([]);
    expect(out?.personNotes).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("answers null when the workspace is not there", async () => {
    const { db } = memoryDb(seed());
    expect(
      await loadTeamContext(db as unknown as SupabaseClient, {
        workspaceId: "nope",
        callerId: null,
        personNotes: true,
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
        personNotes: true,
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
    expect(
      await loadTeamContext(db, { workspaceId: "w1", callerId: null, personNotes: true }),
    ).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
