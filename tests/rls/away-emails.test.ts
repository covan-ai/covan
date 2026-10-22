/**
 * The emails sent while somebody is away (0133) are the engine's to claim.
 *
 * Both claims mark what they hand out as told, so a client that could call
 * them could silence somebody else's reminders, or read another member's
 * thread titles and what waits on them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSql, createTestUser, destroyTestUsers, type TestUser } from "./harness";

let ada: TestUser;

beforeAll(async () => {
  ada = await createTestUser("away-ada");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("the engine's claims", () => {
  it("are refused to a signed-in client", async () => {
    const reminders = await ada.db.rpc("claim_needs_you_reminders", { p_limit: 10 });
    expect(reminders.error).not.toBeNull();
    const weekly = await ada.db.rpc("claim_weekly_summaries", { p_limit: 2 });
    expect(weekly.error).not.toBeNull();
  });
});
