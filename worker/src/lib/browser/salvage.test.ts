import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RoutineEnv } from "../../types";
import { notesOf, salvageRun } from "./salvage";
import type { RunEvent } from "./v4";

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;

let id = 0;
function core(part: Record<string, unknown>): RunEvent {
  id += 1;
  return { id, ts: "2026-10-24T12:00:00Z", type: "core.event", data: { part } };
}
const said = (text: string) => core({ type: "text", text });
const step = (description: string, output?: unknown) =>
  core({ type: "tool", tool: "browser_execute", state: { input: { description }, output } });

describe("notesOf", () => {
  it("keeps what the agent said and what each browser step was for, in order", () => {
    const notes = notesOf([
      said("Starting with the first finder site."),
      step("Search for Ada Lovelace at acme.test", "ada@acme.test (verified)"),
      said("One address found; moving to the second site."),
    ]);
    expect(notes).toBe(
      [
        "Said: Starting with the first finder site.",
        "Step: Search for Ada Lovelace at acme.test",
        "Page: ada@acme.test (verified)",
        "Said: One address found; moving to the second site.",
      ].join("\n"),
    );
  });

  it("leaves out the shell, skills, the run's JSON answer and every other event", () => {
    const notes = notesOf([
      core({ type: "tool", tool: "bash", state: { input: { description: "type the login" } } }),
      core({ type: "tool", tool: "skill", state: { input: { description: "load" } } }),
      said('{"status":"partial"}'),
      said('```json\n{"status":"done"}\n```'),
      { id: 99, ts: "", type: "llm.response", data: { cost_usd: 0.01 } },
      said("the one line kept"),
    ]);
    expect(notes).toBe("Said: the one line kept");
  });

  it("keeps the pages of the last four steps only", () => {
    const events = Array.from({ length: 6 }, (_, i) => step(`step ${i}`, `page ${i}`));
    const notes = notesOf(events) ?? "";
    expect(notes).not.toContain("page 0");
    expect(notes).not.toContain("page 1");
    expect(notes).toContain("Step: step 0");
    for (const i of [2, 3, 4, 5]) expect(notes).toContain(`Page: page ${i}`);
  });

  it("cuts a long page and keeps the end of long notes", () => {
    const events = Array.from({ length: 60 }, (_, i) => said(`${i} ${"x".repeat(300)}`));
    events.push(step("last", "y".repeat(5_000)));
    const notes = notesOf(events) ?? "";
    expect(notes.length).toBeLessThanOrEqual(6_000);
    expect(notes).toContain("Step: last");
    expect(notes).not.toContain("Said: 0 ");
    expect(notes).toMatch(/y…$/);
  });

  it("never hands on a live view or a browser socket", () => {
    const notes = notesOf([
      said("watching https://live.browser-use.test/abc and wss://cdp.test/socket"),
    ]);
    expect(notes).toBe("Said: watching [link] and [link]");
  });

  it("is null when the log holds nothing worth handing on", () => {
    expect(notesOf([])).toBeNull();
    expect(notesOf([said("   ")])).toBeNull();
  });
});

describe("salvageRun", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function page(events: RunEvent[], nextAfter: number | null, hasMore: boolean) {
    return new Response(JSON.stringify({ events, nextAfter, hasMore }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("reads every page of the log, following the cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(page([said("first page")], 10, true))
      .mockResolvedValueOnce(page([said("second page")], 20, false));
    const notes = await salvageRun(ENV, "run-1");
    expect(notes).toBe("Said: first page\nSaid: second page");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/\/runs\/run-1\/events\?after=0$/);
    expect(urls[1]).toMatch(/\/runs\/run-1\/events\?after=10$/);
  });

  it("keeps what it read when a later page fails", async () => {
    fetchMock
      .mockResolvedValueOnce(page([said("kept")], 10, true))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect(await salvageRun(ENV, "run-1")).toBe("Said: kept");
  });

  it("stops at six pages", async () => {
    fetchMock.mockImplementation(async () => page([said("again")], ++id, true));
    await salvageRun(ENV, "run-1");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("is null, not a throw, when the provider cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await salvageRun(ENV, "run-1")).toBeNull();
  });
});
