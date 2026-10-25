/**
 * What the agent was told to keep in mind (0138).
 *
 * A note is one sentence about the team or about a person. A note about a
 * person is its author's alone and can never be shared; a note about the team
 * is its author's until they share it, and then every member reads it and
 * every writer may correct or remove it. Nobody — an admin included — reads or
 * deletes somebody else's private note, and only the author moves one from
 * private to shared, and never back. These policies are the whole access
 * story: the tool, the route and the Settings page all go through the
 * caller's own client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let admin: TestUser;
let author: TestUser;
let colleague: TestUser;
let viewer: TestUser;
let leaver: TestUser;
let seeded: Seeded;

async function add(user: TestUser, role: "member" | "viewer") {
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: admin.workspaceId, user_id: user.id, role });
  if (error) throw new Error(`could not add ${role}: ${error.message}`);
}

type Note = {
  about: "person" | "team";
  scope: "owner" | "workspace";
  text: string;
  source_session_id?: string;
};

function write(user: TestUser, note: Note) {
  return user.db
    .from("memory_notes")
    .insert({ workspace_id: admin.workspaceId, created_by: user.id, ...note })
    .select("id, scope")
    .maybeSingle();
}

async function made(user: TestUser, note: Note): Promise<string> {
  const { data, error } = await write(user, note);
  if (error || !data) throw new Error(`${user.email} could not write a note: ${error?.message}`);
  return data.id as string;
}

async function seen(user: TestUser, id: string) {
  const { data, error } = await user.db.from("memory_notes").select("id").eq("id", id);
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  admin = await createTestUser("notes-admin");
  author = await createTestUser("notes-author");
  colleague = await createTestUser("notes-colleague");
  viewer = await createTestUser("notes-viewer");
  leaver = await createTestUser("notes-leaver");
  await add(author, "member");
  await add(colleague, "member");
  await add(viewer, "viewer");
  await add(leaver, "member");
  // A private thread of the admin's, which nobody else can see.
  seeded = await seedWorkspace(admin);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("memory_notes", () => {
  it("a private note is invisible to a colleague, and to an admin", async () => {
    const id = await made(author, {
      about: "person",
      scope: "owner",
      text: "Prefers answers in bullet points.",
    });

    expect(await seen(author, id)).toEqual([{ id }]);
    expect(await seen(colleague, id)).toEqual([]);
    expect(await seen(admin, id)).toEqual([]);
  });

  it("a shared team note is visible to every member", async () => {
    const id = await made(author, {
      about: "team",
      scope: "workspace",
      text: "Invoices go out on the first working day of the month.",
    });

    for (const user of [author, colleague, viewer, admin]) {
      expect(await seen(user, id)).toEqual([{ id }]);
    }
  });

  it("a note about a person can never be shared", async () => {
    const { error } = await write(author, {
      about: "person",
      scope: "workspace",
      text: "Is on leave every other Friday.",
    });
    expect(error?.code).toBe("23514");

    // Nor by sharing it afterwards.
    const id = await made(author, {
      about: "person",
      scope: "owner",
      text: "Writes in short sentences.",
    });
    const shared = await author.db.from("memory_notes").update({ scope: "workspace" }).eq("id", id);
    expect(shared.error?.code).toBe("23514");
  });

  it("a viewer may keep private notes and may not write team notes", async () => {
    const own = await write(viewer, {
      about: "team",
      scope: "owner",
      text: "The quarterly review is in the second week.",
    });
    expect(own.error).toBeNull();
    expect(own.data?.scope).toBe("owner");

    const shared = await write(viewer, {
      about: "team",
      scope: "workspace",
      text: "Support answers within four hours.",
    });
    expect(shared.data).toBeNull();
    expect(shared.error?.code).toBe("42501");

    // And may not share their private one by updating it.
    const moved = await viewer.db
      .from("memory_notes")
      .update({ scope: "workspace" })
      .eq("id", own.data!.id as string)
      .select("id");
    expect(moved.error?.code).toBe("42501");
    const after = await viewer.db
      .from("memory_notes")
      .select("scope")
      .eq("id", own.data!.id as string)
      .single();
    expect(after.data?.scope).toBe("owner");
  });

  it("a writer demoted to viewer can no longer reword the shared note they wrote", async () => {
    const demoted = await createTestUser("notes-demoted");
    await add(demoted, "member");
    const text = "Releases go out on Tuesdays.";
    const id = await made(demoted, { about: "team", scope: "workspace", text });

    const { error } = await serviceClient()
      .from("workspace_members")
      .update({ role: "viewer" })
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", demoted.id);
    expect(error).toBeNull();

    // Still theirs, so the row is in reach, but the result is a shared note
    // that a viewer could not have written.
    const reworded = await demoted.db
      .from("memory_notes")
      .update({ text: "Releases go out on Fridays." })
      .eq("id", id)
      .select("id");
    expect(reworded.error?.code).toBe("42501");
    expect(reworded.data ?? []).toEqual([]);

    const after = await author.db.from("memory_notes").select("text").eq("id", id).single();
    expect(after.data?.text).toBe(text);
  });

  it("only the author moves a note from private to shared, and never back", async () => {
    const id = await made(author, {
      about: "team",
      scope: "owner",
      text: "The staging database is reset every Sunday night.",
    });

    // A colleague cannot see it, so their update matches nothing.
    const theirs = await colleague.db
      .from("memory_notes")
      .update({ scope: "workspace" })
      .eq("id", id)
      .select("id");
    expect(theirs.data ?? []).toEqual([]);
    expect(await seen(colleague, id)).toEqual([]);

    const shared = await author.db
      .from("memory_notes")
      .update({ scope: "workspace" })
      .eq("id", id)
      .select("scope");
    expect(shared.error).toBeNull();
    expect(shared.data).toEqual([{ scope: "workspace" }]);
    expect(await seen(colleague, id)).toEqual([{ id }]);

    const back = await author.db.from("memory_notes").update({ scope: "owner" }).eq("id", id);
    expect(back.error?.code).toBe("42501");

    // A writer may correct a team note they did not write, and may not take
    // it private either.
    const corrected = await colleague.db
      .from("memory_notes")
      .update({ text: "The staging database is reset every Saturday night." })
      .eq("id", id)
      .select("text");
    expect(corrected.error).toBeNull();
    expect(corrected.data).toEqual([
      { text: "The staging database is reset every Saturday night." },
    ]);
    const taken = await colleague.db.from("memory_notes").update({ scope: "owner" }).eq("id", id);
    expect(taken.error?.code).toBe("42501");
  });

  it("a writer can delete a team note they did not write; nobody deletes another person's private note", async () => {
    const team = await made(author, {
      about: "team",
      scope: "workspace",
      text: "Deploys are frozen during the last week of the year.",
    });
    const mine = await made(author, {
      about: "person",
      scope: "owner",
      text: "Likes the summary first and the detail after.",
    });

    // A viewer is not a writer.
    const byViewer = await viewer.db.from("memory_notes").delete().eq("id", team).select("id");
    expect(byViewer.data ?? []).toEqual([]);
    expect(await seen(author, team)).toEqual([{ id: team }]);

    const byColleague = await colleague.db
      .from("memory_notes")
      .delete()
      .eq("id", team)
      .select("id");
    expect(byColleague.error).toBeNull();
    expect(byColleague.data).toEqual([{ id: team }]);
    expect(await seen(author, team)).toEqual([]);

    for (const user of [colleague, admin]) {
      const gone = await user.db.from("memory_notes").delete().eq("id", mine).select("id");
      expect(gone.data ?? []).toEqual([]);
    }
    expect(await seen(author, mine)).toEqual([{ id: mine }]);
  });

  it("the same sentence twice is refused", async () => {
    await made(author, { about: "team", scope: "owner", text: "Standup is at half past nine." });
    const again = await write(author, {
      about: "team",
      scope: "owner",
      text: "STANDUP is at half past nine.",
    });
    expect(again.error?.code).toBe("23505");

    // Somebody else may say it too.
    const theirs = await write(colleague, {
      about: "team",
      scope: "owner",
      text: "Standup is at half past nine.",
    });
    expect(theirs.error).toBeNull();
  });

  // A unique index is enforced whatever the policies say. Were private and
  // shared notes one key, a writer could set somebody's team note to a guessed
  // sentence and read a 23505 as "they hold this privately".
  it("a team note's text cannot test for its author's private notes", async () => {
    const secret = "Is interviewing at another company.";
    await made(author, { about: "person", scope: "owner", text: secret });
    const team = await made(author, {
      about: "team",
      scope: "workspace",
      text: "The office closes early on Fridays.",
    });

    for (const guess of [secret, secret.toUpperCase()]) {
      const edited = await colleague.db
        .from("memory_notes")
        .update({ text: guess })
        .eq("id", team)
        .select("text");
      expect(edited.error).toBeNull();
      expect(edited.data).toEqual([{ text: guess }]);
    }
  });

  it("nobody else changes the text of a private note, an admin included", async () => {
    const text = "Wants the numbers before the narrative.";
    const mine = await made(author, { about: "person", scope: "owner", text });

    for (const user of [colleague, admin]) {
      const changed = await user.db
        .from("memory_notes")
        .update({ text: "Rewritten by someone else." })
        .eq("id", mine)
        .select("id");
      expect(changed.data ?? []).toEqual([]);
    }
    const after = await author.db.from("memory_notes").select("text").eq("id", mine).single();
    expect(after.data?.text).toBe(text);
  });

  it("refuses an empty note, a note past 280 characters, and one written in somebody else's name", async () => {
    expect((await write(author, { about: "team", scope: "owner", text: "" })).error?.code).toBe(
      "23514",
    );
    expect(
      (await write(author, { about: "team", scope: "owner", text: "x".repeat(281) })).error?.code,
    ).toBe("23514");

    const forged = await author.db
      .from("memory_notes")
      .insert({
        workspace_id: admin.workspaceId,
        created_by: colleague.id,
        about: "team",
        scope: "owner",
        text: "Written in someone else's name.",
      })
      .select("id");
    expect(forged.error?.code).toBe("42501");
  });

  it("names only a thread its author can see", async () => {
    const hidden = await write(author, {
      about: "team",
      scope: "owner",
      text: "Taken from a thread I cannot read.",
      source_session_id: seeded.sessionId,
    });
    expect(hidden.error?.code).toBe("42501");

    const session = await author.db
      .from("chat_sessions")
      .insert({
        agent_id: seeded.agentId,
        user_id: author.id,
        workspace_id: admin.workspaceId,
        visibility: "private",
        title: "Author's thread",
      })
      .select("id")
      .single();
    if (session.error) throw new Error(session.error.message);

    const own = await write(author, {
      about: "team",
      scope: "owner",
      text: "Taken from my own thread.",
      source_session_id: session.data.id as string,
    });
    expect(own.error).toBeNull();
  });

  it("deleting the author's profile removes their private notes and keeps their team notes", async () => {
    await made(leaver, { about: "person", scope: "owner", text: "Wants a reminder on Mondays." });
    await made(leaver, { about: "team", scope: "owner", text: "Their own draft of a rule." });
    const team = await made(leaver, {
      about: "team",
      scope: "workspace",
      text: "Customer calls are recorded only with consent.",
    });

    const service = serviceClient();
    const { error } = await service.from("profiles").delete().eq("id", leaver.id);
    expect(error).toBeNull();

    const { data: left } = await service
      .from("memory_notes")
      .select("id, scope, created_by")
      .eq("workspace_id", admin.workspaceId)
      .in("text", [
        "Wants a reminder on Mondays.",
        "Their own draft of a rule.",
        "Customer calls are recorded only with consent.",
      ]);
    expect(left).toEqual([{ id: team, scope: "workspace", created_by: null }]);
    // Still a team note every member reads.
    expect(await seen(colleague, team)).toEqual([{ id: team }]);
  });
});
