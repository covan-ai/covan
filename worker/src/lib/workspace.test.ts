import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveWorkspaceId } from "./workspace";
import { fakeDb, type QueryContext } from "../test-support/fake-db";

/**
 * `getActiveWorkspaceId` sits in front of almost every workspace-scoped route:
 * it decides which workspace the caller's request applies to. If it ever
 * returned a workspace the caller has left, every route behind it would be
 * operating on the wrong tenant — and RLS would not save them, because the
 * queries that follow are filtered by the id this function returned.
 *
 * The membership re-check on the stored `active_workspace_id` is the part that
 * matters, so that is what these tests pin down.
 */

const USER = "user-1";

/**
 * @param memberOf workspaces the user still belongs to, oldest first.
 * @param activeId what `profiles.active_workspace_id` currently says.
 */
function db(memberOf: string[], activeId: string | null) {
  return fakeDb({
    tables: {
      profiles: {
        select: () => ({ data: { active_workspace_id: activeId }, error: null }),
        update: () => ({ data: null, error: null }),
      },
      workspace_members: {
        select: (ctx: QueryContext) => {
          const wanted = ctx.filters.find((f) => f.column === "workspace_id")?.value as
            | string
            | undefined;

          // Two different queries land here: the membership re-check (filtered
          // by workspace_id) and the oldest-membership fallback (not filtered).
          if (wanted !== undefined) {
            return {
              data: memberOf.includes(wanted) ? { workspace_id: wanted } : null,
              error: null,
            };
          }
          return {
            data: memberOf.length > 0 ? { workspace_id: memberOf[0] } : null,
            error: null,
          };
        },
      },
    },
  });
}

describe("getActiveWorkspaceId", () => {
  it("keeps the stored workspace when the caller is still a member", async () => {
    const { db: client, callsTo } = db(["ws-a", "ws-b"], "ws-b");

    const resolved = await getActiveWorkspaceId(client as unknown as SupabaseClient, USER);

    expect(resolved).toBe("ws-b");
    // Nothing to persist, so nothing should be written.
    expect(callsTo("profiles").filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("falls back to the oldest membership when the caller has left the stored one", async () => {
    // The case this function exists for: an admin removed the user from ws-b,
    // but their profile still points at it.
    const { db: client, callsTo } = db(["ws-a"], "ws-b");

    const resolved = await getActiveWorkspaceId(client as unknown as SupabaseClient, USER);

    expect(resolved).toBe("ws-a");

    const persisted = callsTo("profiles").filter((c) => c.op === "update");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].values).toEqual({ active_workspace_id: "ws-a" });
    expect(persisted[0].filters).toEqual([{ column: "id", value: USER, kind: "eq" }]);
  });

  it("resolves a workspace even when the profile has never had one", async () => {
    const { db: client } = db(["ws-a"], null);

    expect(await getActiveWorkspaceId(client as unknown as SupabaseClient, USER)).toBe("ws-a");
  });

  it("returns null when the caller belongs to nothing", async () => {
    const { db: client, callsTo } = db([], "ws-gone");

    expect(await getActiveWorkspaceId(client as unknown as SupabaseClient, USER)).toBeNull();
    // No workspace resolved means nothing to remember.
    expect(callsTo("profiles").filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("returns null rather than a stale workspace when the fallback query fails", async () => {
    // A failed read must not be mistaken for "still a member of ws-b".
    const client = fakeDb({
      tables: {
        profiles: {
          select: () => ({ data: { active_workspace_id: "ws-b" }, error: null }),
        },
        workspace_members: {
          select: (ctx) =>
            ctx.filters.some((f) => f.column === "workspace_id")
              ? { data: null, error: null }
              : { data: null, error: { message: "connection reset" } },
        },
      },
    });

    expect(await getActiveWorkspaceId(client.db as unknown as SupabaseClient, USER)).toBeNull();
  });
});
