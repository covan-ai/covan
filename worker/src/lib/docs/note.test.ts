import { describe, expect, it } from "vitest";
import { fakeDb } from "../../test-support/fake-db";
import { documentJobNote, documentStanding } from "./note";

const NOW = new Date("2026-10-15T14:33:00Z");

function dbWith(rows: unknown[] | null, error: { message: string; code?: string } | null = null) {
  return fakeDb({
    tables: { document_jobs: { select: () => ({ data: rows, error }) } },
  });
}

describe("documentJobNote", () => {
  it("tells the model a filed document is done, so it does not start it again", async () => {
    const fake = dbWith([
      {
        title: "Satış Ekibi İçin Özet",
        status: "ready",
        cursor: 8,
        outline: new Array(8).fill({}),
      },
      {
        title: "Yönetim Kurulu Raporu",
        status: "ready",
        cursor: 12,
        outline: new Array(12).fill({}),
      },
    ]);

    const note = await documentJobNote(fake.db as never, "sess-1", NOW);

    expect(note).toContain('1. "Yönetim Kurulu Raporu" — finished and filed');
    expect(note).toContain('2. "Satış Ekibi İçin Özet" — finished and filed');
    expect(note).toContain("Do not call write_document again");
  });

  it("asks only about this conversation, and only the last day", async () => {
    const fake = dbWith([]);
    await documentJobNote(fake.db as never, "sess-1", NOW);
    const query = fake.callsTo("document_jobs")[0];
    expect(query.filters).toContainEqual(
      expect.objectContaining({ column: "session_id", value: "sess-1", kind: "eq" }),
    );
    expect(query.filters).toContainEqual(
      expect.objectContaining({
        column: "created_at",
        kind: "gt",
        value: "2026-10-14T14:33:00.000Z",
      }),
    );
  });

  it("says nothing when there is nothing, or the read fails", async () => {
    expect(await documentJobNote(dbWith([]).db as never, "sess-1", NOW)).toBeNull();
    expect(
      await documentJobNote(dbWith(null, { message: "x", code: "42501" }).db as never, "s", NOW),
    ).toBeNull();
  });
});

describe("documentStanding", () => {
  it("says how far a document being written has got", () => {
    expect(documentStanding({ status: "writing", cursor: 3, outline: new Array(7) })).toContain(
      "3 of 7 sections done",
    );
  });

  it("passes a failure's reason on, with what the person can do", () => {
    const line = documentStanding({ status: "failed", error: "Out of credits." });
    expect(line).toContain("Out of credits.");
    expect(line).toContain("try again from its card");
  });
});
