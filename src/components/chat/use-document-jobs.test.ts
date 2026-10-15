import { describe, expect, it, vi } from "vitest";
import type { DocumentJob } from "@/lib/api-client";

// The hook's module reaches the API client, which builds a Supabase client at
// import; these are its pure halves and need neither.
vi.mock("@/lib/api-client", () => ({ api: {} }));

const { isWriting, placeJobs, shouldPoll, statusLine } = await import("./use-document-jobs");

const job = (over: Partial<DocumentJob> = {}): DocumentJob => ({
  id: "job-1",
  agentId: "agent-1",
  sessionId: "sess-1",
  bundleId: "bundle-1",
  origin: "tool",
  instruction: "Write it up.",
  title: "Q3",
  status: "writing",
  written: 1,
  total: 3,
  documentId: null,
  error: null,
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  finishedAt: null,
  sections: [],
  ...over,
});

const at = (iso: string) => Date.parse(iso);

describe("the poll", () => {
  it("asks again only while something is being written", () => {
    expect(shouldPoll([job({ status: "queued" })])).toBe(true);
    expect(shouldPoll([job({ status: "filing" })])).toBe(true);
    expect(shouldPoll([job({ status: "ready" }), job({ status: "failed" })])).toBe(false);
    expect(shouldPoll(undefined)).toBe(false);
  });

  it("counts a stopped document as finished", () => {
    expect(isWriting(job({ status: "stopped" }))).toBe(false);
  });
});

describe("statusLine", () => {
  it("says where the writing is", () => {
    expect(statusLine(job())).toBe("Writing — 1 of 3 sections");
    expect(statusLine(job({ status: "queued" }))).toBe("Planning the sections…");
    expect(statusLine(job({ status: "stopped" }))).toBe("Stopped at 1 of 3 sections");
  });

  it("says why it failed, in the server's words", () => {
    expect(statusLine(job({ status: "failed", error: "Out of credits." }))).toBe("Out of credits.");
  });
});

describe("placeJobs", () => {
  const messages = [
    { id: "q", role: "user", createdAt: at("2026-10-15T11:59:00Z") },
    { id: "a1", role: "assistant", createdAt: at("2026-10-15T12:00:05Z") },
    { id: "a2", role: "assistant", createdAt: at("2026-10-15T12:05:00Z") },
  ];

  it("puts a card under the reply written after the job started", () => {
    const placed = placeJobs([job()], messages);
    expect(placed.byMessage.get("a1")?.map((j) => j.id)).toEqual(["job-1"]);
    expect(placed.trailing).toEqual([]);
  });

  it("keeps a job with no reply after it at the foot", () => {
    const late = job({ id: "late", createdAt: "2026-10-15T12:10:00Z" });
    expect(placeJobs([late], messages).trailing.map((j) => j.id)).toEqual(["late"]);
  });

  it("orders two cards under one reply by when they started", () => {
    const second = job({ id: "b", createdAt: "2026-10-15T12:00:02Z" });
    const first = job({ id: "a", createdAt: "2026-10-15T12:00:01Z" });
    expect(
      placeJobs([second, first], messages)
        .byMessage.get("a1")
        ?.map((j) => j.id),
    ).toEqual(["a", "b"]);
  });
});
