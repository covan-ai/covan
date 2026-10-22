import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";

const rpc = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ rpc }) }));

const { invitationPreview } = await import("./invitation-preview");

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function post(body: unknown) {
  const app = new Hono<AppEnv>();
  app.route("/", invitationPreview);
  return app.request("/invitations/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => rpc.mockReset());

describe("POST /invitations/preview", () => {
  it("answers the email's id and token with what they are an invitation to", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          workspace_name: "Acme",
          inviter_name: "Ada",
          email: "bob@acme.com",
          role: "member",
          open: true,
        },
      ],
      error: null,
    });

    const res = await post({ id: ID, token: "tok" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      workspaceName: "Acme",
      inviterName: "Ada",
      email: "bob@acme.com",
      role: "member",
      open: true,
      memberCount: null,
      agentCount: null,
      expiresAt: null,
    });
    // The token goes to the function as it came; the function hashes it.
    expect(rpc).toHaveBeenCalledWith("invitation_preview", { p_invite_id: ID, p_token: "tok" });
  });

  it("answers a wrong pair with the same 404 as no invitation at all", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    const res = await post({ id: ID, token: "wrong" });

    expect(res.status).toBe(404);
  });

  it("refuses a body that is not an id and a token before asking anything", async () => {
    const res = await post({ id: "not-a-uuid", token: "" });

    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});
