import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import type { Entitlements } from "../lib/entitlements";

const { transcribeAudio } = vi.hoisted(() => ({ transcribeAudio: vi.fn() }));
vi.mock("../lib/transcribe", async (orig) => ({
  ...(await orig<typeof import("../lib/transcribe")>()),
  transcribeAudio,
}));

const { transcribe } = await import("./transcribe");

function appWith(entitlements: Partial<Entitlements> = {}) {
  const record = vi.fn(async () => {});
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("entitlements", {
      check: async () => ({ allowed: true }),
      record,
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
      ...entitlements,
    } as Entitlements);
    c.env = { OPENAI_API_KEY: "sk-test" } as never;
    await next();
  });
  app.route("/", transcribe);
  return { app, record };
}

/** A recording of `bytes` bytes, posted the way the composer posts one. */
function post(app: Hono<AppEnv>, file: File | null, headers: Record<string, string> = {}) {
  const form = new FormData();
  if (file) form.append("file", file);
  return app.request("/transcribe", { method: "POST", body: form, headers });
}

const recording = (bytes = 4000, name = "recording.webm", type = "audio/webm") =>
  new File([new Uint8Array(bytes)], name, { type });

describe("POST /transcribe", () => {
  beforeEach(() => {
    transcribeAudio.mockReset();
    transcribeAudio.mockResolvedValue({ text: "merhaba dünya", audioTokens: 2400 });
  });

  it("gives back what was said", async () => {
    const { app } = appWith();

    const res = await post(app, recording());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: "merhaba dünya" });
  });

  // Before the audio is sent anywhere, for the same reason the chat stream
  // checks first: the spend happens at OpenAI, not here.
  it("refuses a caller who is out of allowance, and transcribes nothing", async () => {
    const { app } = appWith({
      check: async () => ({
        allowed: false,
        used: 1200,
        limit: 1000,
        resetsAt: "2026-09-01T00:00:00.000Z",
      }),
    });

    const res = await post(app, recording());

    expect(res.status).toBe(402);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("charges the caller for the audio it transcribed", async () => {
    const { app, record } = appWith();

    await post(app, recording());

    // 2400 audio tokens weighted at 0.32 — see transcriptionCost.
    expect(record).toHaveBeenCalledWith("user-1", 768);
  });

  it("refuses a request carrying no recording", async () => {
    const { app } = appWith();

    const res = await post(app, null);

    expect(res.status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("refuses an empty recording", async () => {
    const { app } = appWith();

    const res = await post(app, recording(0));

    expect(res.status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  // The two-minute ceiling the composer enforces, enforced again here — the
  // client half of a limit is a courtesy, not the limit.
  it("refuses a recording longer than the ceiling", async () => {
    const { app } = appWith();

    const res = await post(app, recording(3 * 1024 * 1024));

    expect(res.status).toBe(413);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("refuses it on the declared length, before reading the body", async () => {
    const { app } = appWith();

    const res = await post(app, recording(), { "content-length": String(9 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("refuses a file that is not audio anyone can transcribe", async () => {
    const { app } = appWith();

    const res = await post(app, recording(4000, "notes.pdf", "application/pdf"));

    expect(res.status).toBe(400);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("takes what Safari records as readily as what Chrome records", async () => {
    const { app } = appWith();

    const res = await post(app, recording(4000, "recording.mp4", "audio/mp4"));

    expect(res.status).toBe(200);
  });

  // Nothing was heard, so there is nothing to put in the composer. Answering 200
  // with an empty string would have the button appear to do nothing at all.
  it("says so when the recording held no speech", async () => {
    transcribeAudio.mockResolvedValue({ text: "   ", audioTokens: 40 });
    const { app } = appWith();

    const res = await post(app, recording());

    expect(res.status).toBe(422);
  });

  it("still charges for a recording that held no speech", async () => {
    transcribeAudio.mockResolvedValue({ text: "", audioTokens: 40 });
    const { app, record } = appWith();

    await post(app, recording());

    expect(record).toHaveBeenCalledWith("user-1", 13);
  });

  it("reports a failure at OpenAI as a failure, not as silence", async () => {
    transcribeAudio.mockRejectedValue(new Error("upstream is down"));
    const { app } = appWith();

    const res = await post(app, recording());

    expect(res.status).toBe(502);
  });
});
