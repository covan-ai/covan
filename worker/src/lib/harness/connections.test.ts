import { describe, it, expect } from "vitest";
import { connectionsManifest, type ToolConnection } from "./connections";

/**
 * The sentence that tells an agent what to do with its connections.
 *
 * Worth a test of its own because it is an INSTRUCTION, not a description:
 * whatever it says, the model does. It used to say "use describe_connection
 * first when you do not already know what one holds" with no exception, and
 * three production turns in a row duly opened with a `describe_connection` on
 * a connected app — a call that can only ever answer "there is nothing here to
 * describe, use find_tool", because a connected app's operations belong to the
 * catalogue rather than to the row. One step of eight, spent obeying us.
 */

function connection(over: Partial<ToolConnection>): ToolConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    label: "A thing",
    transport: "http",
    base_url: "https://example.com",
    auth_kind: "static_header",
    allowed_methods: ["GET"],
    config: {},
    account_id: null,
    secret_ciphertext: null,
    toolkit_slug: null,
    status: "active",
    ...over,
  } as ToolConnection;
}

const GMAIL = connection({
  id: "conn-gmail",
  label: "Ana's Gmail",
  transport: "composio",
  auth_kind: "composio",
  toolkit_slug: "gmail",
});

const WAREHOUSE = connection({ id: "conn-db", label: "Warehouse", transport: "sql" });

describe("connectionsManifest", () => {
  it("says nothing at all when there is nothing connected", () => {
    expect(connectionsManifest([])).toBe("");
  });

  it("names the toolkit, which is the only join between a slug and an id", () => {
    // `find_tool` answers with GMAIL_SEND_EMAIL and nothing else; without the
    // toolkit here the model cannot tell which connection that belongs to.
    const text = connectionsManifest([GMAIL]);
    expect(text).toContain("conn-gmail");
    expect(text).toContain("gmail");
  });

  it("does not send an agent to describe a connected app", () => {
    const text = connectionsManifest([GMAIL]);
    expect(text).not.toContain("describe_connection");
    expect(text).toContain("needs no describing");
    expect(text).toContain("find_tool");
  });

  it("still sends one to describe a database, where the answer is real", () => {
    const text = connectionsManifest([WAREHOUSE]);
    expect(text).toContain("describe_connection");
  });

  it("gives each kind its own sentence when a workspace has both", () => {
    const text = connectionsManifest([GMAIL, WAREHOUSE]);
    expect(text).toContain("describe_connection on a database or an API");
    expect(text).toContain("A connected app needs no describing");
  });

  it("keeps the line that stops a model inventing an id, whatever is connected", () => {
    for (const set of [[GMAIL], [WAREHOUSE], [GMAIL, WAREHOUSE]]) {
      expect(connectionsManifest(set)).toContain("Never guess an id that is not on this list");
    }
  });
});
