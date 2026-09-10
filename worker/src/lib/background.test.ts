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

/** A document store but no OAuth credentials: can write, cannot authenticate. */
const storeOnly = { ...base, DOCS_DIR: "/tmp/docs" };

/** Everything a sync needs. Both halves, which is the point. */
const withStore = {
  ...storeOnly,
  NOTION_CLIENT_ID: "notion-client",
  NOTION_CLIENT_SECRET: "notion-secret",
};

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

  // The hazard this guards, stated as the thing that must not happen: claiming.
  //
  // A Worker with somewhere to write but no way to authenticate reaches
  // `sync.ts`, fails `isConfigured` there, and that path does not skip — it
  // PAUSES the connection and tells the person an operator has to set the
  // client credentials. So one deploy of the engine with the storage binding
  // and without the secrets would pause every connection in every workspace.
  //
  // Nothing downstream can tell that apart from a deployment that genuinely
  // dropped the provider, which is precisely why the decision has to be made
  // here, where "this Worker" and "this deployment" are still distinguishable.
  it("claims nothing when no source has its client credentials on this Worker", async () => {
    runDueRoutines.mockResolvedValue({ claimed: 0, ok: 0, failed: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runScheduledWork(storeOnly);

    expect(runDueConnections).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOTION_CLIENT_ID"));
    warn.mockRestore();
  });

  // One is enough to be worth a tick. The provider that is not configured is
  // handled per connection downstream; what must not happen is the whole tick
  // standing down because the *other* source is missing.
  it("syncs when one source is configured and the other is not", async () => {
    runDueRoutines.mockResolvedValue({ claimed: 0, ok: 0, failed: 0 });
    const onlyGoogle = {
      ...storeOnly,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
    };

    await runScheduledWork(onlyGoogle);

    expect(runDueConnections).toHaveBeenCalledWith(onlyGoogle);
  });

  it("propagates a routine failure rather than carrying on to the connections", async () => {
    runDueRoutines.mockRejectedValue(new Error("claim_due_routines failed"));

    await expect(runScheduledWork(withStore)).rejects.toThrow("claim_due_routines failed");
    expect(runDueConnections).not.toHaveBeenCalled();
  });
});
