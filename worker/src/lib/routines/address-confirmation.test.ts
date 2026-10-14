import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../secret-box";

/**
 * An email channel sends only to an address that has said yes (0096).
 *
 * The service client is stubbed at its edges — the admin API that says what
 * the owner's own address is, and the `delivery_channels` writes this module
 * makes — because what is held here is the decision, not PostgREST.
 */
const getUserById = vi.fn();
const writes: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
let sentToday = 0;
let confirmRows: Array<{ id: string }> = [];

function chain(values?: Record<string, unknown>) {
  const filters: Array<[string, unknown]> = [];
  const self = {
    eq: (column: string, value: unknown) => (filters.push([`eq:${column}`, value]), self),
    is: (column: string, value: unknown) => (filters.push([`is:${column}`, value]), self),
    gt: (column: string, value: unknown) => (filters.push([`gt:${column}`, value]), self),
    select: () => self,
    then: (resolve: (v: unknown) => unknown) => {
      if (values) writes.push({ values, filters });
      const counting = !values;
      return resolve(
        counting ? { count: sentToday, error: null } : { data: confirmRows, error: null },
      );
    },
  };
  return self;
}

vi.mock("../supabase", () => ({
  serviceClient: () => ({
    auth: { admin: { getUserById } },
    from: () => ({
      select: () => chain(),
      update: (values: Record<string, unknown>) => chain(values),
    }),
  }),
}));

const {
  askToConfirm,
  confirmAddress,
  confirmationEmail,
  hashConfirmationToken,
  readyForDelivery,
  DAILY_LINKS_PER_OWNER,
} = await import("./address-confirmation");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <routines@example.com>",
  ALLOWED_ORIGIN: "https://app.example.com",
  SUPABASE_URL: "https://db.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "service",
} as never;
const NOW = new Date("2026-10-13T12:00:00Z");

const resend = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  writes.length = 0;
  sentToday = 0;
  confirmRows = [];
  getUserById.mockReset().mockResolvedValue({
    data: { user: { email: "Owner@Example.com", email_confirmed_at: "2026-01-01T00:00:00Z" } },
    error: null,
  });
  resend.mockClear();
  vi.stubGlobal("fetch", resend);
});

afterEach(() => vi.unstubAllGlobals());

async function emailChannel(address: string, over: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    user_id: "owner-1",
    kind: "email",
    secret_ciphertext: await encryptSecret(address, KEY),
    confirmed_at: null,
    confirmation_sent_at: null,
    ...over,
  };
}

describe("readyForDelivery", () => {
  it("confirms the owner's own confirmed address on the spot, without mailing it", async () => {
    const channel = await readyForDelivery(ENV, await emailChannel("owner@example.com"), NOW);

    expect(channel.confirmed_at).toBe(NOW.toISOString());
    expect(writes[0]?.values).toMatchObject({ confirmed_at: NOW.toISOString() });
    expect(writes[0]?.filters).toContainEqual(["eq:id", "ch-1"]);
    expect(resend).not.toHaveBeenCalled();
  });

  it("does not take an unconfirmed sign-in address as proof of a mailbox", async () => {
    getUserById.mockResolvedValue({
      data: { user: { email: "owner@example.com", email_confirmed_at: null } },
      error: null,
    });

    const channel = await readyForDelivery(ENV, await emailChannel("owner@example.com"), NOW);

    expect(channel.confirmed_at).toBeNull();
    expect(channel.asked).toBe("sent");
  });

  it("asks any other address, with a fixed message carrying no text the owner wrote", async () => {
    const channel = await readyForDelivery(ENV, await emailChannel("stranger@example.org"), NOW);

    expect(channel.confirmed_at).toBeNull();
    expect(channel.asked).toBe("sent");
    const [, init] = resend.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.to).toEqual(["stranger@example.org"]);
    expect(sent.subject).toBe("Confirm this address for Covan");
    expect(sent.text).toMatch(/https:\/\/app\.example\.com\/confirm-address#token=/);
    // The link's token is stored only as its hash.
    const token = decodeURIComponent(/#token=([^\s]+)/.exec(sent.text)![1]);
    expect(writes[0]?.values.confirmation_hash).toBe(await hashConfirmationToken(token));
    expect(writes[0]?.values.confirmation_hash).not.toBe(token);
  });

  it("does not ask the same address twice in a day", async () => {
    const recently = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const channel = await readyForDelivery(
      ENV,
      await emailChannel("stranger@example.org", { confirmation_sent_at: recently }),
      NOW,
    );

    expect(channel.asked).toBe("recently");
    expect(resend).not.toHaveBeenCalled();
  });

  it("asks no more than the daily number of addresses for one person", async () => {
    sentToday = DAILY_LINKS_PER_OWNER;

    const channel = await readyForDelivery(ENV, await emailChannel("stranger@example.org"), NOW);

    expect(channel.asked).toBe("limit");
    expect(resend).not.toHaveBeenCalled();
  });

  it("passes a confirmed channel and every other kind straight through", async () => {
    const confirmed = await readyForDelivery(
      ENV,
      await emailChannel("stranger@example.org", { confirmed_at: "2026-10-01T00:00:00Z" }),
      NOW,
    );
    expect(confirmed.confirmed_at).toBe("2026-10-01T00:00:00Z");

    const slack = await readyForDelivery(
      ENV,
      { ...(await emailChannel("x")), kind: "slack_webhook" },
      NOW,
    );
    expect(slack.kind).toBe("slack_webhook");
    expect(getUserById).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });

  it("treats an admin API that cannot answer as 'not their own', and asks", async () => {
    getUserById.mockRejectedValue(new Error("gotrue down"));

    const channel = await readyForDelivery(ENV, await emailChannel("owner@example.com"), NOW);

    expect(channel.confirmed_at).toBeNull();
  });
});

describe("askToConfirm", () => {
  it("says so when this deployment cannot send mail, and stores no link", async () => {
    const outcome = await askToConfirm(
      { ...(ENV as object), RESEND_API_KEY: "" } as never,
      (await import("../supabase")).serviceClient(ENV) as never,
      { id: "ch-1", user_id: "owner-1", confirmation_sent_at: null },
      "stranger@example.org",
      NOW,
    );

    expect(outcome).toBe("unavailable");
    expect(writes).toHaveLength(0);
  });
});

describe("confirmAddress", () => {
  it("confirms the channel the token names, once, within the week", async () => {
    confirmRows = [{ id: "ch-1" }];

    expect(await confirmAddress(ENV, "the-token-from-the-link", NOW)).toBe(true);

    const update = writes[0]!;
    expect(update.values).toEqual({ confirmed_at: NOW.toISOString(), confirmation_hash: null });
    expect(update.filters).toContainEqual([
      "eq:confirmation_hash",
      await hashConfirmationToken("the-token-from-the-link"),
    ]);
    expect(update.filters).toContainEqual(["is:confirmed_at", null]);
    expect(update.filters).toContainEqual([
      "gt:confirmation_sent_at",
      new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    ]);
  });

  it("answers false for a token that matched nothing", async () => {
    confirmRows = [];
    expect(await confirmAddress(ENV, "not-a-token-anybody-was-sent", NOW)).toBe(false);
  });
});

describe("the question itself", () => {
  it("names nobody and nothing that somebody chose", () => {
    const mail = confirmationEmail(
      "x@example.org",
      "https://app.example.com/confirm-address#token=t",
    );
    expect(mail.subject).toBe("Confirm this address for Covan");
    expect(mail.text).toContain("If not, ignore this email");
  });
});
