import { describe, it, expect } from "vitest";
import { connectionsManifest, unavailableTools, type ToolConnection } from "./connections";

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

/**
 * What a connection has learnt it cannot do.
 *
 * The largest failure class in the harness lives behind this function, so its
 * edges are worth pinning: Composio's catalogue is the union of what every
 * account of an application could have, a connected account holds a subset, and
 * no documented parameter asks which. The subset is therefore learnt from 404s
 * and kept on the row — and a reader that is wrong in either direction is
 * expensive. Too eager, and it hides an operation that works; too shy, and the
 * 404 is bought again.
 */
describe("unavailableTools", () => {
  const withBag = (bag: unknown): ToolConnection =>
    ({ ...GMAIL, config: { unavailable_tools: bag } }) as ToolConnection;

  it("is empty for a connection that has never met a missing operation", () => {
    expect(unavailableTools(GMAIL).size).toBe(0);
  });

  it("reads back what was recorded", () => {
    const live = withBag({ GMAIL_SEND_EMAIL: new Date().toISOString() });
    expect([...unavailableTools(live)]).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("forgets an entry old enough to have stopped being true", () => {
    // Re-authorising an application with wider scopes adds operations the
    // account did not have. A permanent exclusion would hide one forever with
    // nothing in the product saying why.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(unavailableTools(withBag({ GMAIL_SEND_EMAIL: old })).size).toBe(0);
  });

  it("keeps an entry whose date it cannot read", () => {
    // An older or hand-edited bag. The slug was still put there by a real 404,
    // and discarding it would buy that 404 again — the expiry is a safety
    // valve, not a reason to distrust the record.
    expect([...unavailableTools(withBag({ GMAIL_SEND_EMAIL: "not a date" }))]).toEqual([
      "GMAIL_SEND_EMAIL",
    ]);
  });

  it("treats a malformed bag as knowing nothing, rather than throwing", () => {
    // `config` is a jsonb column anything could have written. A search that
    // throws here is a search that fails; a search that knows nothing is where
    // this started.
    for (const bad of [null, "GMAIL_SEND_EMAIL", ["GMAIL_SEND_EMAIL"], 42]) {
      expect(unavailableTools(withBag(bad)).size).toBe(0);
    }
  });
});
