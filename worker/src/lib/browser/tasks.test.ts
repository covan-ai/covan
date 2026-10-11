import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoutineEnv } from "../../types";
import { fakeDb, type QueryContext } from "../../test-support/fake-db";

/** What the service-role client was asked to insert, one entry per insert. */
const inserted: Record<string, unknown>[] = [];

const service = fakeDb({
  tables: {
    browser_tasks: {
      insert: (ctx: QueryContext) => {
        inserted.push(ctx.values ?? {});
        return { data: { id: "bt-1" }, error: null };
      },
    },
  },
});

vi.mock("../supabase", () => ({ serviceClient: () => service.db }));

import { recordBrowserTask } from "./tasks";

const ENV = {} as RoutineEnv;
const WHO = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "user-1",
  sessionId: "chat-1",
  task: "read the pricing table on example.com",
};

beforeEach(() => {
  inserted.length = 0;
});

describe("recordBrowserTask", () => {
  it("writes a v4 run with its run id, its browser session and the version that says how to poll it", async () => {
    const id = await recordBrowserTask(ENV, {
      ...WHO,
      providerRunId: "run-1",
      browserSessionId: "bs-1",
    });

    expect(id).toBe("bt-1");
    expect(inserted[0]).toMatchObject({
      api_version: "v4",
      provider_run_id: "run-1",
      browser_session_id: "bs-1",
      // Not null, and read by every v2-era reader: an empty string here would
      // be a provider address that addresses nothing. The run id is the one
      // value that means something to all of them.
      provider_task_id: "run-1",
      status: "queued",
    });
  });

  /**
   * Ruling R32: the run says whether it carried a saved login, so deliver can
   * tell "the saved login did not work" from "this run never had it".
   */
  it("records the saved login a run carried", async () => {
    await recordBrowserTask(ENV, {
      ...WHO,
      providerRunId: "run-1",
      browserSessionId: "bs-1",
      credentialId: "cred-1",
    });
    expect(inserted[0]).toMatchObject({ credential_id: "cred-1" });
  });

  it("records no saved login for a run that carried none, leaving the column's null", async () => {
    await recordBrowserTask(ENV, { ...WHO, providerRunId: "run-1", browserSessionId: "bs-1" });
    expect(inserted[0]).not.toHaveProperty("credential_id");
    await recordBrowserTask(ENV, {
      ...WHO,
      providerRunId: "run-2",
      browserSessionId: "bs-1",
      credentialId: null,
    });
    expect(inserted[1]).not.toHaveProperty("credential_id");
  });

  it("still writes a v2 task the way it always has, for the take-over's re-run", async () => {
    await recordBrowserTask(ENV, { ...WHO, providerTaskId: "bu-task-1", retryOf: "bt-0" });

    expect(inserted[0]).toMatchObject({
      provider_task_id: "bu-task-1",
      retry_of: "bt-0",
    });
    // The column's default says v2; a v2 row names no run and no session.
    expect(inserted[0]).not.toHaveProperty("provider_run_id");
    expect(inserted[0]).not.toHaveProperty("browser_session_id");
    expect(inserted[0]).not.toHaveProperty("api_version");
  });
});
