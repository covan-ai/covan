import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { findToolTool } from "./find-tool";

/**
 * Searching a catalogue nobody has connected yet.
 *
 * The property worth pinning is the one that makes this tool different from
 * every other one in the harness: it is offered to a workspace with nothing
 * connected, because the answer "you would need to connect Linear first" is
 * only available to something that can see the unconnected half of the
 * catalogue. The other half of that property is that it never hands the model a
 * connection id for an application the workspace has not connected.
 */
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: async () => ({ allowed: true }),
      record: async () => {},
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
    }),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const GMAIL_CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Ana's Gmail",
  transport: "composio",
  base_url: "https://backend.composio.dev",
  auth_kind: "composio",
  allowed_methods: ["GET"],
  config: {},
  account_id: null,
  toolkit_slug: "gmail",
  status: "active",
};

function ctxWith(connections: Record<string, unknown>[] = []): ToolContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ order: async () => ({ data: connections, error: null }) }),
          }),
        }),
      }),
    } as unknown as ToolContext["db"],
    env: { ROUTINE_SECRET_KEY: "k", COMPOSIO_API_KEY: "ck_test" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
  };
}

function catalogue(items: unknown[]) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

const GMAIL_SEND = {
  slug: "GMAIL_SEND_EMAIL",
  name: "Send email",
  description: "Send an email from the connected account.",
  toolkit: { slug: "GMAIL" },
  input_parameters: { required: ["recipient_email", "subject"] },
};

const LINEAR_CREATE = {
  slug: "LINEAR_CREATE_ISSUE",
  name: "Create issue",
  description: "Create an issue.",
  toolkit: { slug: "LINEAR" },
  input_parameters: { required: ["title"] },
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe("find_tool", () => {
  it("is offered whatever the workspace has connected, and only where there is a key", () => {
    // No `needs`, so `available.ts` falls through to true — the point of a
    // catalogue-wide search is that it answers before anything is connected.
    expect(findToolTool.needs).toBeUndefined();
    expect(findToolTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(findToolTool.isConfigured({ COMPOSIO_API_KEY: "ck" } as ToolEnv)).toBe(true);
  });

  it("gives a connection id for a connected app and refuses to invent one otherwise", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND, LINEAR_CREATE]));
    const out = await findToolTool.run({ query: "send a message" }, ctxWith([GMAIL_CONNECTION]));

    expect(out.kind).toBe("ok");
    const content = out.kind === "ok" ? out.content : "";
    expect(content).toContain("connectionId: conn-1");
    // The model is told in words what to do next, because `connectionsManifest`
    // ends with "never guess an id that is not on this list" and a slug with no
    // id beside it is an invitation to make one up.
    expect(content).toContain("LINEAR_CREATE_ISSUE");
    // Asserted on the unconnected entry itself rather than on the whole
    // answer: the closing line legitimately says the word `connectionId`, and a
    // looser match would pass whatever the entry said.
    const linearBlock = content
      .split("\n\n")
      .find((block) => block.startsWith("LINEAR_CREATE_ISSUE"));
    expect(linearBlock).toContain("NOT CONNECTED");
    expect(linearBlock).not.toContain("connectionId");
  });

  it("puts what the workspace can actually run first", async () => {
    fetchMock.mockResolvedValue(catalogue([LINEAR_CREATE, GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";
    expect(content.indexOf("GMAIL_SEND_EMAIL")).toBeLessThan(
      content.indexOf("LINEAR_CREATE_ISSUE"),
    );
  });

  it("names the required parameters without fetching a schema", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    expect(out.kind === "ok" && out.content).toContain("needs: recipient_email, subject");
    // One request, not one per candidate: a full schema each would arrive at
    // the model truncated mid-JSON by `MAX_TOOL_OUTPUT_CHARS`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches one full schema when asked for detail", async () => {
    fetchMock.mockResolvedValueOnce(catalogue([GMAIL_SEND])).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...GMAIL_SEND,
          input_parameters: {
            type: "object",
            required: ["recipient_email"],
            properties: { recipient_email: { type: "string" } },
          },
        }),
        { status: 200 },
      ),
    );
    const out = await findToolTool.run(
      { query: "send", detail: true },
      ctxWith([GMAIL_CONNECTION]),
    );
    expect(out.kind === "ok" && out.content).toContain("recipient_email");
    expect(out.kind === "ok" && out.content).toContain("Arguments:");
  });

  it("says so plainly when nothing matches", async () => {
    fetchMock.mockResolvedValue(catalogue([]));
    const out = await findToolTool.run({ query: "brew coffee" }, ctxWith());
    expect(out.kind === "ok" && out.content).toContain("No operation in the catalogue matches");
  });

  it("forwards the catalogue's own failure rather than a shrug", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const out = await findToolTool.run({ query: "send" }, ctxWith());
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("rate limited");
  });
});
