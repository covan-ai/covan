import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const complete = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: "dGVzdC1yb3V0aW5lLXNlY3JldC1rZXktMzItYnl0ZXM=",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <covan@example.com>",
  ALLOWED_ORIGIN: "http://localhost:3000",
  DOCS_DIR: "/data/docs",
};

/** A complete, passing source object, with overrides merged in. */
function valid(overrides: Record<string, string | undefined> = {}) {
  return { ...complete, ...overrides };
}

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

const DEMO_SERVICE_ROLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q";
const DEMO_ROUTINE_KEY = "Y292YW4tbG9jYWwtZGV2LXJvdXRpbmUta2V5LTAwMDE=";

describe("published default secrets", () => {
  it("refuses to start with the demo service-role key on a non-local origin", () => {
    expect(() =>
      loadEnv(
        valid({
          ALLOWED_ORIGIN: "https://covan.example.com",
          SUPABASE_SERVICE_ROLE_KEY: DEMO_SERVICE_ROLE,
        }),
      ),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuses to start with the demo routine key on a non-local origin", () => {
    expect(() =>
      loadEnv(
        valid({
          ALLOWED_ORIGIN: "https://covan.example.com",
          ROUTINE_SECRET_KEY: DEMO_ROUTINE_KEY,
        }),
      ),
    ).toThrow(/ROUTINE_SECRET_KEY/);
  });

  it("names every offending variable in one message", () => {
    expect(() =>
      loadEnv(
        valid({
          ALLOWED_ORIGIN: "https://covan.example.com",
          SUPABASE_SERVICE_ROLE_KEY: DEMO_SERVICE_ROLE,
          ROUTINE_SECRET_KEY: DEMO_ROUTINE_KEY,
        }),
      ),
    ).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY.*ROUTINE_SECRET_KEY|ROUTINE_SECRET_KEY.*SUPABASE_SERVICE_ROLE_KEY/s,
    );
  });

  it("allows the demo values on localhost, which is what they are for", () => {
    expect(() =>
      loadEnv(
        valid({
          ALLOWED_ORIGIN: "http://localhost:3000",
          SUPABASE_SERVICE_ROLE_KEY: DEMO_SERVICE_ROLE,
          ROUTINE_SECRET_KEY: DEMO_ROUTINE_KEY,
        }),
      ),
    ).not.toThrow();
  });
});

describe("ROUTINE_SECRET_KEY shape", () => {
  it("rejects a key that does not decode to 16, 24 or 32 bytes", () => {
    expect(() => loadEnv(valid({ ROUTINE_SECRET_KEY: btoa("too short") }))).toThrow(
      /ROUTINE_SECRET_KEY/,
    );
  });

  it("rejects a key that is not valid base64", () => {
    expect(() => loadEnv(valid({ ROUTINE_SECRET_KEY: "!!!not base64!!!" }))).toThrow(
      /ROUTINE_SECRET_KEY/,
    );
  });

  it("accepts a freshly generated 32-byte key", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(() => loadEnv(valid({ ROUTINE_SECRET_KEY: key }))).not.toThrow();
  });
});
