import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { persona } from "./persona";

/**
 * "Write from name" on a Claude model, 2026-10-21: four drafts in a row came
 * back as "Couldn't write a persona". The ledger showed each one charged at
 * exactly 400 output tokens — the ceiling — so the JSON had been cut inside
 * the string and the parse failed on a persona the provider had written.
 *
 * Two things are pinned here: the ceiling the route now asks for, and that a
 * draft which still hits it is reported as cut off rather than as a model
 * that could not follow the format.
 */

const USER = { id: "user-1", email: "a@example.com" };

const openaiCreate = vi.fn();
const anthropicCreate = vi.fn();
const guardCredits = vi.fn();
const recordCredits = vi.fn();

vi.mock("../lib/openai", () => ({
  createOpenAI: () => ({ chat: { completions: { create: openaiCreate } } }),
}));

vi.mock("../lib/anthropic", () => ({
  createAnthropic: () => ({ messages: { create: anthropicCreate } }),
}));

vi.mock("../lib/entitlements/guard", () => ({
  guardCredits: (...args: unknown[]) => guardCredits(...args),
  recordCredits: (...args: unknown[]) => recordCredits(...args),
}));

function app() {
  const a = new Hono<AppEnv>();
  a.use("/*", async (c, next) => {
    c.set("user", USER as never);
    await next();
  });
  a.route("/", persona);
  return a;
}

const suggest = (body: unknown, env: Record<string, string> = { OPENAI_API_KEY: "sk-test" }) =>
  app().request(
    "/persona/suggest",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    env,
  );

const PERSONA = "Sen bir satış asistanısın. Kısa ve net konuşursun.";

beforeEach(() => {
  vi.clearAllMocks();
  guardCredits.mockResolvedValue(null);
  recordCredits.mockResolvedValue(undefined);
  openaiCreate.mockResolvedValue({
    choices: [
      { message: { content: JSON.stringify({ persona: PERSONA }) }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 150, completion_tokens: 90 },
  });
  anthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ persona: PERSONA }) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 250, output_tokens: 300 },
  });
});

describe("POST /persona/suggest", () => {
  it("drafts a persona from the title", async () => {
    const res = await suggest({ name: "Satış Asistanı" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persona: PERSONA });
    expect(recordCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: "persona", completionTokens: 90 }),
    );
  });

  it("gives a Claude draft room to finish", async () => {
    const res = await suggest(
      { name: "Satış Asistanı", model: "claude-opus-5" },
      { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    expect(res.status).toBe(200);
    const sent = anthropicCreate.mock.calls[0][0] as { max_tokens: number; model: string };
    expect(sent.model).toBe("claude-opus-5");
    // 400 cut four Turkish drafts in a row at exactly 400 tokens.
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1200);
  });

  it("says a draft was cut off rather than that the model failed", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"persona":"Sen bir satış asistanısın. Kısa ve' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 256, output_tokens: 1200 },
    });
    const res = await suggest(
      { name: "Satış Asistanı", model: "claude-opus-5" },
      { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "persona draft was cut off" });
    // Charged either way: the provider wrote it.
    expect(recordCredits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: "persona", completionTokens: 1200 }),
    );
  });

  it("reports a reply that is not a persona as a failed draft", async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"title":"nope"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 150, completion_tokens: 10 },
    });
    const res = await suggest({ name: "Satış Asistanı" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "failed to draft persona" });
  });

  it("answers 400 without a name and spends nothing", async () => {
    const res = await suggest({});
    expect(res.status).toBe(400);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it("spends nothing when the credits have already been refused", async () => {
    guardCredits.mockResolvedValue(new Response("over", { status: 402 }));
    const res = await suggest({ name: "Satış Asistanı" });
    expect(res.status).toBe(402);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(recordCredits).not.toHaveBeenCalled();
  });
});
