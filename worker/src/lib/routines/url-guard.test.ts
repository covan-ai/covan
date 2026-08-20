import { describe, it, expect } from "vitest";
import { assertFetchableUrl, ownHostsFrom } from "./url-guard";

const OWN = ["covan-worker.workers.dev", "api.example.com"];

describe("assertFetchableUrl", () => {
  it("accepts an ordinary https url", () => {
    expect(assertFetchableUrl("https://www.reddit.com/r/saas/new/.rss", OWN).host).toBe(
      "www.reddit.com",
    );
  });

  it("accepts http", () => {
    expect(assertFetchableUrl("http://example.com/feed", OWN).protocol).toBe("http:");
  });

  it.each(["file:///etc/passwd", "ftp://example.com", "data:text/plain,x", "javascript:alert(1)"])(
    "rejects the scheme in %s",
    (url) => {
      expect(() => assertFetchableUrl(url, OWN)).toThrow(/unsafe url/);
    },
  );

  it.each([
    "http://127.0.0.1/x",
    "http://10.1.2.3/x",
    "http://192.168.0.1/x",
    "http://172.16.0.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/x",
    "http://[::1]/x",
  ])("rejects the private address in %s", (url) => {
    expect(() => assertFetchableUrl(url, OWN)).toThrow(/unsafe url/);
  });

  it("allows a public IP literal", () => {
    expect(assertFetchableUrl("http://172.32.0.1/x", OWN).host).toBe("172.32.0.1");
  });

  it("rejects the worker's own hosts, so it cannot be pointed at itself", () => {
    expect(() => assertFetchableUrl("https://api.example.com/routines", OWN)).toThrow(/unsafe url/);
    expect(() => assertFetchableUrl("https://covan-worker.workers.dev/health", OWN)).toThrow(
      /unsafe url/,
    );
  });

  it("matches own hosts case-insensitively", () => {
    expect(() => assertFetchableUrl("https://API.EXAMPLE.COM/x", OWN)).toThrow(/unsafe url/);
  });

  it("rejects an unparseable url", () => {
    expect(() => assertFetchableUrl("not a url", OWN)).toThrow(/unsafe url/);
  });

  it("rejects trailing dot on own host", () => {
    expect(() => assertFetchableUrl("https://api.example.com./x", OWN)).toThrow(/unsafe url/);
  });

  it("rejects trailing dot on localhost", () => {
    expect(() => assertFetchableUrl("http://localhost./x", OWN)).toThrow(/unsafe url/);
  });

  it("rejects own host with non-default port", () => {
    expect(() => assertFetchableUrl("https://api.example.com:8443/x", OWN)).toThrow(/unsafe url/);
  });

  it("rejects url when ownHosts entry has a port and url doesn't", () => {
    const ownWithPort = ["api.example.com:8443"];
    expect(() => assertFetchableUrl("https://api.example.com/x", ownWithPort)).toThrow(
      /unsafe url/,
    );
  });

  it("rejects *.workers.dev hosts regardless of ownHosts", () => {
    expect(() => assertFetchableUrl("https://some-other-worker.workers.dev/x", OWN)).toThrow(
      /unsafe url/,
    );
  });

  it("allows notworkers.dev (not a .workers.dev domain)", () => {
    expect(assertFetchableUrl("https://notworkers.dev/x", OWN).host).toBe("notworkers.dev");
  });

  it("rejects IPv4-mapped IPv6 loopback", () => {
    expect(() => assertFetchableUrl("http://[::ffff:127.0.0.1]/x", OWN)).toThrow(/unsafe url/);
  });

  it("rejects IPv4-mapped IPv6 private range", () => {
    expect(() => assertFetchableUrl("http://[::ffff:10.0.0.1]/x", OWN)).toThrow(/unsafe url/);
  });
});

// Shared by the creation path (routes/routines.ts) and the execution path
// (the cron dispatcher). They used to build this list separately, and the
// creation-side copy was both stricter about input and blind to WORKER_HOST —
// so a url the executor would refuse could still be saved.
describe("ownHostsFrom", () => {
  it("takes the host out of each ALLOWED_ORIGIN entry", () => {
    expect(
      ownHostsFrom({ ALLOWED_ORIGIN: "https://app.example.com, https://staging.example.com:8443" }),
    ).toEqual(["app.example.com", "staging.example.com:8443"]);
  });

  it("includes WORKER_HOST, so creation refuses what execution would refuse", () => {
    expect(
      ownHostsFrom({ ALLOWED_ORIGIN: "https://app.example.com", WORKER_HOST: "api.example.com" }),
    ).toEqual(["app.example.com", "api.example.com"]);
  });

  it("assumes https for a scheme-less entry rather than throwing", () => {
    expect(ownHostsFrom({ ALLOWED_ORIGIN: "app.example.com" })).toEqual(["app.example.com"]);
  });

  it("drops a malformed entry instead of 500ing every routine create", () => {
    expect(
      ownHostsFrom({ ALLOWED_ORIGIN: "https://app.example.com,", WORKER_HOST: "not a host :://" }),
    ).toEqual(["app.example.com"]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(ownHostsFrom({ ALLOWED_ORIGIN: "" })).toEqual([]);
  });
});
