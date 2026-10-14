/**
 * A connected application's completion nonce is kept as a hash no client can
 * read (0093).
 *
 * The nonce reaches only the browser Composio sends back; finishing the
 * connection takes it. A hash the browser could read back would be one
 * somebody could match, so the column is granted to no client role.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSql, createTestUser, destroyTestUsers, type TestUser } from "./harness";

let member: TestUser;

beforeAll(async () => {
  member = await createTestUser("composio-nonce");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("tool_connections.completion_nonce_hash", () => {
  it("is not readable by the workspace's own members", async () => {
    const { error } = await member.db.from("tool_connections").select("completion_nonce_hash");
    expect(error?.code).toBe("42501");
  });

  it("is not writable either", async () => {
    const { error } = await member.db
      .from("tool_connections")
      .update({ completion_nonce_hash: "0".repeat(64) })
      .eq("workspace_id", member.workspaceId);
    expect(error?.code).toBe("42501");
  });
});
