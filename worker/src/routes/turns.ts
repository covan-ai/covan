import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { mapMessage } from "../lib/dto";
import { turnHost } from "../lib/turns";

/**
 * A conversation's turn, for the browser that is not the one that started it.
 *
 * Usually it is the same browser, a minute later: it asked, opened another
 * conversation or closed the tab, and has come back while the answer is still
 * being written. These three are how it finds out (`GET …/turn`), picks the
 * stream back up from the start (`GET …/turn/stream`), and stops it from a
 * screen that no longer holds the request that started it (`POST
 * …/turn/stop`).
 *
 * Every one reads the session through the caller's own client first, so a
 * conversation somebody cannot see is one whose turn they cannot see either —
 * the host itself knows nothing about who may read what.
 *
 * On a deployment with no host (`turnHost` returns null) there is never a turn
 * to find, and each answers as if none were running.
 */
const turns = new Hono<AppEnv>();

/** How far apart this Worker's clock and the database's may be. */
const CLOCK_SLACK_MS = 5_000;

async function canRead(c: Context<AppEnv>): Promise<boolean> {
  const { data } = await c
    .get("db")
    .from("chat_sessions")
    .select("id")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  return Boolean(data);
}

// GET /sessions/:id/turn
turns.get("/sessions/:id/turn", async (c) => {
  if (!(await canRead(c))) return c.json({ error: "not found" }, 404);
  const host = turnHost(c.env);
  const status = host ? await host.status(c.req.param("id")) : null;
  return c.json({
    turn: status
      ? {
          running: status.running,
          // Whether this caller may stop it. Somebody watching a shared
          // conversation sees the answer arrive, but the turn is run with the
          // standing of the person who asked.
          mine: status.userId === c.get("user").id,
          startedAt: status.startedAt,
        }
      : null,
    // Whether "no turn" is an answer at all. With a host, it means the last
    // one ended, so a question with nothing under it was never answered and
    // the screen can say so (covan-ai/covan#350). Without one, every turn ends
    // with its request and this endpoint cannot see any of them.
    hosted: host !== null,
  });
});

// GET /sessions/:id/turn/stream
turns.get("/sessions/:id/turn/stream", async (c) => {
  if (!(await canRead(c))) return c.json({ error: "not found" }, 404);
  const host = turnHost(c.env);
  const stream = host ? await host.stream(c.req.param("id")) : null;
  return stream ?? c.body(null, 204);
});

// POST /sessions/:id/turn/stop
//
// Answers with the reply the turn kept, when it kept one, so the screen can put
// it where the streamed text was without a gap — the same reason `done`
// carries its row.
turns.post("/sessions/:id/turn/stop", async (c) => {
  if (!(await canRead(c))) return c.json({ error: "not found" }, 404);
  const sessionId = c.req.param("id");
  const host = turnHost(c.env);
  if (!host) return c.json({ stopped: false, message: null });

  const before = await host.status(sessionId);
  const result = await host.stop(sessionId, c.get("user").id);
  if (result === "forbidden") return c.json({ error: "this is not yours to stop" }, 403);
  if (result === "idle" || !before) return c.json({ stopped: false, message: null });

  const { data: row } = await c
    .get("db")
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .eq("role", "assistant")
    .is("superseded_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Only a row this turn wrote. A turn stopped before it said anything keeps
  // nothing, and the newest reply is then the previous turn's.
  const kept =
    row && Date.parse(row.created_at as string) >= before.startedAt - CLOCK_SLACK_MS ? row : null;
  return c.json({ stopped: true, message: kept ? mapMessage(kept) : null });
});

export { turns };
