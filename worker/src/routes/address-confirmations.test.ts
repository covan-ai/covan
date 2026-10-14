import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";

const confirmAddress = vi.fn(async (_env: unknown, _token: string) => true);
vi.mock("../lib/routines/address-confirmation", () => ({ confirmAddress }));

const { addressConfirmationsPublic } = await import("./address-confirmations");

function post(body: unknown) {
  const app = new Hono<AppEnv>();
  app.route("/", addressConfirmationsPublic);
  return app.request(
    "/address-confirmations",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    {} as never,
  );
}

describe("POST /address-confirmations", () => {
  it("confirms with the token from the link, and answers nothing more", async () => {
    const res = await post({ token: "a-token-from-the-email-link" });
    expect(res.status).toBe(204);
    expect(confirmAddress).toHaveBeenCalledWith(expect.anything(), "a-token-from-the-email-link");
  });

  it("gives one answer for every token that does not work", async () => {
    confirmAddress.mockResolvedValueOnce(false);
    const res = await post({ token: "used-expired-or-made-up-token" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "that link is not valid" });
  });

  it("refuses a body that is not a token before asking anything", async () => {
    confirmAddress.mockClear();
    expect((await post({})).status).toBe(400);
    expect((await post({ token: "short" })).status).toBe(400);
    expect(confirmAddress).not.toHaveBeenCalled();
  });
});
