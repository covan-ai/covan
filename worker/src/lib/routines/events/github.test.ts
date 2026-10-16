import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../../hmac";
import type { AdapterContext, SubscriptionRow } from "./adapter";
import { CATALOGUE } from "./catalog";
import { GITHUB_ADAPTER, GITHUB_EVENTS, GITHUB_HOOK_ID, type GitHubDelivery } from "./github";

const SECRET = "s3cret";

function ctx(type: string, over: Partial<SubscriptionRow> = {}, secret: string | null = SECRET) {
  const def = CATALOGUE.eventType(type);
  if (!def) throw new Error(type);
  return {
    env: {} as never,
    routine: { id: "r1", user_id: "u1", workspace_id: "w1" },
    subscription: {
      routine_id: "r1",
      provider: "github",
      event_type: type,
      config: {},
      external_id: "gh_" + "a".repeat(32),
      secret_ciphertext: "sealed",
      state: {},
      status: "active",
      status_detail: null,
      expires_at: null,
      attempts: 0,
      ...over,
    },
    eventType: def,
    secret,
  } satisfies AdapterContext;
}

async function delivery(event: string, payload: unknown, secret = SECRET): Promise<GitHubDelivery> {
  const body = JSON.stringify(payload);
  return {
    event,
    delivery: "d-1",
    signature: `sha256=${await hmacSha256Hex(secret, body)}`,
    body,
  };
}

const PUSH = {
  ref: "refs/heads/main",
  after: "abc",
  compare: "https://github.com/acme/web/compare/a...b",
  repository: { full_name: "acme/web" },
  pusher: { name: "ayse" },
  commits: [
    { id: "3f2a91c0000", message: "Fix the table\n\nlong body", author: { name: "Ayşe" } },
    { id: "8c01d4e0000", message: "Bump", author: { name: "Mert" } },
  ],
};

describe("the GitHub entries", () => {
  it("are in the catalogue, served by github, needing nothing connected", () => {
    for (const spec of GITHUB_EVENTS) {
      expect(CATALOGUE.eventType(spec.def.id)).toBe(spec.def);
      expect(spec.def.provider).toBe("github");
      expect(spec.def.requires).toEqual({ kind: "none" });
    }
  });
});

describe("GITHUB_ADAPTER.subscribe", () => {
  it("makes an unguessable URL id and a secret the first time", async () => {
    const result = await GITHUB_ADAPTER.subscribe(
      ctx("github.push", { external_id: null, secret_ciphertext: null }, null),
    );
    expect(result.externalId).toMatch(GITHUB_HOOK_ID);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the URL and secret already pasted into GitHub", async () => {
    const c = ctx("github.push");
    expect(await GITHUB_ADAPTER.subscribe(c)).toEqual({
      externalId: c.subscription.external_id,
      secret: SECRET,
    });
  });
});

describe("GITHUB_ADAPTER.authenticate", () => {
  it("accepts GitHub's signature over the exact body", async () => {
    expect(
      await GITHUB_ADAPTER.authenticate!(await delivery("push", PUSH), ctx("github.push")),
    ).toBe(true);
  });

  it("refuses another secret, a changed body, no signature, or no secret", async () => {
    const c = ctx("github.push");
    const forged = await delivery("push", PUSH, "other");
    expect(await GITHUB_ADAPTER.authenticate!(forged, c)).toBe(false);
    const tampered = {
      ...(await delivery("push", PUSH)),
      body: JSON.stringify({ ...PUSH, ref: "x" }),
    };
    expect(await GITHUB_ADAPTER.authenticate!(tampered, c)).toBe(false);
    expect(
      await GITHUB_ADAPTER.authenticate!({ ...(await delivery("push", PUSH)), signature: "" }, c),
    ).toBe(false);
    expect(
      await GITHUB_ADAPTER.authenticate!(
        await delivery("push", PUSH),
        ctx("github.push", {}, null),
      ),
    ).toBe(false);
  });
});

describe("GITHUB_ADAPTER.normalize", () => {
  it("describes a push: branch, who, the commits' first lines", async () => {
    const event = await GITHUB_ADAPTER.normalize(await delivery("push", PUSH), ctx("github.push"));
    expect(event).toMatchObject({
      eventId: "github:d-1",
      label: "GitHub · Push to main",
      fields: { branch: "main", repository: "acme/web" },
    });
    expect(event?.text).toContain("Repository: acme/web");
    expect(event?.text).toContain("- 3f2a91c Fix the table — Ayşe");
    expect(event?.text).not.toContain("long body");
  });

  it("runs nothing for a tag, a deleted branch, a ping or another kind of event", async () => {
    const c = ctx("github.push");
    expect(
      await GITHUB_ADAPTER.normalize(await delivery("push", { ...PUSH, ref: "refs/tags/v1" }), c),
    ).toBeNull();
    expect(
      await GITHUB_ADAPTER.normalize(await delivery("push", { ...PUSH, deleted: true }), c),
    ).toBeNull();
    expect(await GITHUB_ADAPTER.normalize(await delivery("ping", { zen: "hi" }), c)).toBeNull();
    expect(
      await GITHUB_ADAPTER.normalize(await delivery("issues", { action: "opened" }), c),
    ).toBeNull();
    expect(
      await GITHUB_ADAPTER.normalize(
        { event: "push", delivery: "d", signature: "", body: "not json" },
        c,
      ),
    ).toBeNull();
  });

  it("calls a closed pull request that was merged merged", async () => {
    const pr = {
      action: "closed",
      number: 7,
      repository: { full_name: "acme/web" },
      sender: { login: "mert" },
      pull_request: {
        number: 7,
        title: "Dark mode",
        merged: true,
        user: { login: "mert" },
        head: { ref: "dark" },
        base: { ref: "main" },
        html_url: "https://github.com/acme/web/pull/7",
        body: "Adds a toggle.",
      },
    };
    const event = await GITHUB_ADAPTER.normalize(
      await delivery("pull_request", pr),
      ctx("github.pull_request"),
    );
    expect(event?.fields?.action).toBe("merged");
    expect(event?.text).toContain("Pull request: #7 Dark mode");
    expect(event?.text).toContain("Branches: dark → main");
    expect(event?.text).toContain("Adds a toggle.");
  });

  it("leaves out a pull request that arrives as an issue", async () => {
    const event = await GITHUB_ADAPTER.normalize(
      await delivery("issues", {
        action: "opened",
        repository: { full_name: "acme/web" },
        issue: { number: 3, title: "x", pull_request: { url: "…" } },
      }),
      ctx("github.issues"),
    );
    expect(event).toBeNull();
  });
});

describe("the GitHub filters", () => {
  const push = GITHUB_EVENTS.find((s) => s.def.id === "github.push")!.def;
  const pr = GITHUB_EVENTS.find((s) => s.def.id === "github.pull_request")!.def;
  const at = (fields: Record<string, string>) => ({ eventId: "e", text: "", fields });

  it("matches a push to any branch with none set, else only the named ones", () => {
    expect(push.matches!({}, at({ branch: "feature" }))).toBe(true);
    expect(push.matches!({ branch: "main, release" }, at({ branch: "release" }))).toBe(true);
    expect(push.matches!({ branch: "main" }, at({ branch: "maintenance" }))).toBe(false);
  });

  it("matches only opened pull requests by default, and everything for any", () => {
    const defaults = pr.config.parse({});
    expect(pr.matches!(defaults, at({ action: "opened" }))).toBe(true);
    expect(pr.matches!(defaults, at({ action: "synchronize" }))).toBe(false);
    expect(pr.matches!({ action: "any" }, at({ action: "synchronize" }))).toBe(true);
    expect(pr.matches!({ action: "merged" }, at({ action: "closed" }))).toBe(false);
  });
});
