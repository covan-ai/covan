import { describe, expect, it } from "vitest";
import { reportOnlyPolicy } from "./csp";

describe("reportOnlyPolicy", () => {
  it("names this build's own API and Supabase, and Supabase's socket", () => {
    const policy = reportOnlyPolicy({
      apiUrl: "https://api.example.com",
      supabaseUrl: "https://ref.supabase.co",
    });
    expect(policy).toContain(
      "connect-src 'self' https://api.example.com https://ref.supabase.co wss://ref.supabase.co",
    );
    expect(policy).toContain("img-src 'self' data: blob: https://api.example.com");
    expect(policy).not.toContain("posthog");
  });

  it("adds PostHog only to a build that has it", () => {
    expect(reportOnlyPolicy({ posthogHost: "https://eu.i.posthog.com" })).toContain(
      "https://*.posthog.com",
    );
  });

  it("drops an origin it cannot read rather than writing it in", () => {
    expect(reportOnlyPolicy({ apiUrl: "not a url" })).toContain("connect-src 'self';");
  });
});
