import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { priorOfferings, priorSearches } from "./offerings";
import { searchMemoKey } from "./tools/find-tool";

/**
 * What a later turn is allowed to know about an earlier one.
 *
 * Both functions here read the same table through the same door, and the door
 * is the point: `message_steps` is behind `message_is_visible` (0060), so the
 * caller's own client decides what comes back. See the module docblock for why
 * no cache in front of it would be safe.
 *
 * The mock records what it was asked for, because in this module the filters
 * are not an implementation detail — one of them is what keeps another tool's
 * arguments out of memory.
 */
type Row = Record<string, unknown>;

function dbWith(answer: { rows?: Row[] | null; error?: unknown }) {
  const eqs: Array<[string, unknown]> = [];
  const selects: string[] = [];
  const limits: number[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["not", "order"]) {
    chain[method] = () => chain;
  }
  chain.select = (columns: string) => {
    selects.push(columns);
    return chain;
  };
  chain.eq = (column: string, value: unknown) => {
    eqs.push([column, value]);
    return chain;
  };
  chain.limit = async (n: number) => {
    limits.push(n);
    if (answer.error) return { data: null, error: answer.error };
    return { data: answer.rows ?? [], error: null };
  };
  return {
    db: { from: () => chain } as unknown as SupabaseClient,
    asked: { eqs, selects, limits },
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("priorOfferings", () => {
  it("unions what every earlier step offered", async () => {
    const { db } = dbWith({
      rows: [
        { offered: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"] },
        { offered: ["GMAIL_SEND_EMAIL"] },
      ],
    });
    expect(await priorOfferings(db, "sess-1")).toEqual(
      new Set(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"]),
    );
  });

  it("is empty when the database refuses, rather than failing the turn", async () => {
    const { db } = dbWith({ error: { message: "column offered does not exist" } });
    expect(await priorOfferings(db, "sess-1")).toEqual(new Set());
  });
});

/**
 * The search a conversation has already paid for.
 *
 * covan#216: 94 discovery steps, 24 byte-identical repeats, 20 of them in a
 * later turn, 80,368 characters bought twice. Nothing crossed turns but the
 * offered set, so turn two re-ran turn one's search to be handed candidates it
 * was already allowed to run.
 */
describe("priorSearches", () => {
  const step = (request: Row, offered: string[] | null) => ({ request, offered });

  it("keys a stored search exactly as find_tool keys a live one", async () => {
    const { db } = dbWith({
      rows: [step({ query: "send email", toolkit: "gmail" }, ["GMAIL_SEND_EMAIL"])],
    });

    const searches = await priorSearches(db, "sess-1");

    // The agreement that makes this work at all. Two places build this key —
    // the tool from the model's arguments, this from the stored row — and a
    // drift between them is a memo that never hits and nothing that fails.
    const key = searchMemoKey({ query: "send email", toolkit: "gmail" });
    expect(key).not.toBeNull();
    expect(searches.get(key as string)).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("matches a question the model asked again in different capitals", async () => {
    const { db } = dbWith({ rows: [step({ query: "  Send Email " }, ["GMAIL_SEND_EMAIL"])] });
    const searches = await priorSearches(db, "sess-1");
    expect(searches.get(searchMemoKey({ query: "send email" }) as string)).toEqual([
      "GMAIL_SEND_EMAIL",
    ]);
  });

  it("keeps the ranked order the search answered in", async () => {
    // Newest first out of the database, so a conversation past the ceiling
    // keeps its most recent searches — but the slugs of one search must come
    // back in the order it offered them, because the model takes the first.
    const { db } = dbWith({
      rows: [
        step({ query: "send email" }, ["GMAIL_SEND_SOMETHING_ELSE"]),
        step({ query: "send email" }, ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]),
      ],
    });
    const searches = await priorSearches(db, "sess-1");
    expect(searches.get(searchMemoKey({ query: "send email" }) as string)).toEqual([
      "GMAIL_SEND_EMAIL",
      "GMAIL_REPLY_TO_THREAD",
      "GMAIL_SEND_SOMETHING_ELSE",
    ]);
  });

  it("does not lose the first answer to a repeat that offered nothing new", async () => {
    // The production shape from #216: turn two ran the byte-identical search
    // and recorded `offered = NULL`, meaning every candidate was already in the
    // seeded set. Keyed on that row alone, the memo would name nothing.
    const { db } = dbWith({
      rows: [
        step({ query: "send email" }, null),
        step({ query: "send email" }, ["GMAIL_SEND_EMAIL"]),
      ],
    });
    const searches = await priorSearches(db, "sess-1");
    expect(searches.get(searchMemoKey({ query: "send email" }) as string)).toEqual([
      "GMAIL_SEND_EMAIL",
    ]);
  });

  it("does not remember a search that found nothing", async () => {
    // The same rule the per-turn memo already follows: a fruitless search is
    // the useful kind of repeat, and the shortened retry depends on it.
    const { db } = dbWith({ rows: [step({ query: "brew coffee" }, null)] });
    const searches = await priorSearches(db, "sess-1");
    expect(searches.has(searchMemoKey({ query: "brew coffee" }) as string)).toBe(false);
  });

  it("skips a row whose arguments cannot be keyed", async () => {
    const { db } = dbWith({
      rows: [
        step({}, ["A_SLUG"]),
        step({ query: 7 }, ["B_SLUG"]),
        step({ query: "ok" }, ["C_SLUG"]),
      ],
    });
    const searches = await priorSearches(db, "sess-1");
    expect([...searches.values()].flat()).toEqual(["C_SLUG"]);
  });

  it("asks the database for find_tool's own successful steps and nothing else", async () => {
    const { db, asked } = dbWith({ rows: [] });
    await priorSearches(db, "sess-1");

    // Not tidiness. `message_steps.request` holds whatever arguments the tool
    // was called with — an http_request body, a query_database statement — and
    // this is the one read that pulls that column. It stays narrowed to the
    // tool whose arguments it is entitled to, in the database rather than here.
    expect(asked.eqs).toContainEqual(["tool", "find_tool"]);
    expect(asked.eqs).toContainEqual(["status", "ok"]);
    // Through the session's own messages, which is the tenant check.
    expect(asked.eqs).toContainEqual(["messages.session_id", "sess-1"]);
    expect(asked.selects.join()).toContain("messages!inner(session_id)");
    expect(asked.limits[0]).toBeGreaterThan(0);
  });

  it("is empty when the database refuses, rather than failing the turn", async () => {
    const { db } = dbWith({ error: { message: "no" } });
    expect(await priorSearches(db, "sess-1")).toEqual(new Map());
  });

  it("is empty when the client cannot reach the database at all", async () => {
    const db = {
      from: () => {
        throw new Error("fetch failed");
      },
    } as unknown as SupabaseClient;
    expect(await priorSearches(db, "sess-1")).toEqual(new Map());
  });
});
