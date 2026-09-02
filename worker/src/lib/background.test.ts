import { describe, it, expect, vi, beforeEach } from "vitest";

const { runDueRoutines, runDueConnections } = vi.hoisted(() => ({
  runDueRoutines: vi.fn(),
  runDueConnections: vi.fn(),
}));
vi.mock("./routines/dispatcher", () => ({ runDueRoutines }));
vi.mock("./connections/dispatcher", () => ({ runDueConnections }));

import { runScheduledWork } from "./background";

const base = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Routines <routines@example.com>",
  ALLOWED_ORIGIN: "https://app.example.com",
};

const withStore = { ...base, DOCS_DIR: "/tmp/docs" };

describe("runScheduledWork", () => {
  beforeEach(() => {
    runDueRoutines.mockReset();
    runDueConnections.mockReset();
    runDueConnections.mockResolvedValue({ claimed: 0, ok: 0, failed: 0 });
  });

  // The whole point of the sequencing: a busy routine tick has already spent
  // most of a Free invocation's 50 subrequests, so a sync started after it
  // would die partway through rather than not start.
  it("leaves the connections alone on a tick that had routines to run", async () => {
    runDueRoutines.mockResolvedValue({ claimed: 2, ok: 2, failed: 0 });

    await runScheduledWork(withStore);

    expect(runDueConnections).not.toHaveBeenCalled();
  });

  it("syncs connections on an idle tick", async () => {
    runDueRoutines.mockResolvedValue({ claimed: 0, ok: 0, failed: 0 });

    await runScheduledWork(withStore);

    expect(runDueConnections).toHaveBeenCalledWith(withStore);
  });

  // The cron-only Worker as it shipped before connections existed: it can
  // deliver routines and has nowhere to put a document. Skipping is correct;
  // skipping silently is not, because the symptom an operator sees is "Notion
  // never syncs" with nothing anywhere to explain it.
  it("says why, and does not sync, when no document store is bound", async () => {
    runDueRoutines.mockResolvedValue({ claimed: 0, ok: 0, failed: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runScheduledWork(base);

    expect(runDueConnections).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DOCS or DOCS_DIR"));
    warn.mockRestore();
  });

  it("propagates a routine failure rather than carrying on to the connections", async () => {
    runDueRoutines.mockRejectedValue(new Error("claim_due_routines failed"));

    await expect(runScheduledWork(withStore)).rejects.toThrow("claim_due_routines failed");
    expect(runDueConnections).not.toHaveBeenCalled();
  });
});
