import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const complete = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: "cm9vdGtleQ==",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <covan@example.com>",
  ALLOWED_ORIGIN: "http://localhost:3000",
  DOCS_DIR: "/data/docs",
};

describe("loadEnv", () => {
  it("builds bindings from the process environment", () => {
    const env = loadEnv(complete);
    expect(env.SUPABASE_URL).toBe("https://x.supabase.co");
    expect(env.DOCS_DIR).toBe("/data/docs");
  });

  it("leaves DOCS unset so getDocStore picks the filesystem", () => {
    const env = loadEnv(complete);
    expect(env.DOCS).toBeUndefined();
  });

  it("names every missing required variable at once", () => {
    expect(() => loadEnv({ SUPABASE_URL: "https://x.supabase.co" })).toThrow(
      /SUPABASE_ANON_KEY.*SUPABASE_SERVICE_ROLE_KEY.*OPENAI_API_KEY/s,
    );
  });

  it("treats an empty string as missing", () => {
    expect(() => loadEnv({ ...complete, OPENAI_API_KEY: "" })).toThrow(/OPENAI_API_KEY/);
  });

  it("allows the optional variables to be absent", () => {
    const { RESEND_API_KEY, RESEND_FROM, ...rest } = complete;
    expect(() => loadEnv(rest)).not.toThrow();
  });

  it("carries OPENAI_BASE_URL and OPENAI_MODEL through when the operator sets them", () => {
    const env = loadEnv({
      ...complete,
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_MODEL: "llama3.3:70b",
    });
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_MODEL).toBe("llama3.3:70b");
  });

  it("leaves the endpoint unset when the operator says nothing, so the default stays OpenAI", () => {
    const env = loadEnv(complete);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it("carries the rate limits through when the operator sets them", () => {
    const env = loadEnv({
      ...complete,
      RATE_LIMIT_STANDARD_PER_MINUTE: "300",
      RATE_LIMIT_EXPENSIVE_PER_MINUTE: "0",
    });
    expect(env.RATE_LIMIT_STANDARD_PER_MINUTE).toBe("300");
    expect(env.RATE_LIMIT_EXPENSIVE_PER_MINUTE).toBe("0");
  });

  it("leaves them unset when nothing is configured, so lib/ratelimit takes its defaults", () => {
    // Unset must not mean unlimited. The defaults are what makes a stack nobody
    // configured still bounded, which is the whole point of limiting in the API
    // rather than only in the operator's proxy.
    const env = loadEnv(complete);
    expect(env.RATE_LIMIT_STANDARD_PER_MINUTE).toBeUndefined();
    expect(env.RATE_LIMIT_EXPENSIVE_PER_MINUTE).toBeUndefined();
  });
});
