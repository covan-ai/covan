import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

vi.mock("./supabase/client", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

const { api } = await import("./api-client");

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => vi.unstubAllGlobals());

/**
 * An account with no workspace yet (0115) gets a 404 from /me. It has to come
 * back as a value, not an error: an errored query with no data is reset to
 * `pending` whenever a second observer mounts, and the authed gate's
 * "Loading…" unmounted /welcome on every such reset — an endless loop on the
 * one page that account could use.
 */
describe("api.me", () => {
  it("answers null for an account with no workspace", async () => {
    answer(404, { error: "no workspace found for user", code: "no_workspace" });
    await expect(api.me()).resolves.toBeNull();
  });

  it("still throws on an outage", async () => {
    answer(500, { error: "failed to load profile" });
    await expect(api.me()).rejects.toMatchObject({ status: 500 });
  });

  it("stays settled when a second screen starts watching it", async () => {
    answer(404, { code: "no_workspace" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const gate = new QueryObserver(client, { queryKey: ["me"], queryFn: () => api.me() });
    const seen: string[] = [];
    const stop = gate.subscribe((r) => seen.push(r.status));
    await vi.waitFor(() => expect(gate.getCurrentResult().status).toBe("success"));

    // /welcome mounting its own observer of the same query.
    const welcome = new QueryObserver(client, { queryKey: ["me"], queryFn: () => api.me() });
    const stopWelcome = welcome.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(gate.getCurrentResult().status).toBe("success");
    expect(gate.getCurrentResult().data).toBeNull();
    expect(seen.filter((s) => s === "pending").length).toBeLessThanOrEqual(1);
    stop();
    stopWelcome();
  });
});
