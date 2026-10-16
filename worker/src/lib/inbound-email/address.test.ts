import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN,
  addressName,
  addressOf,
  agentAddress,
  inboundDomain,
  localPartsOn,
  newAgentToken,
  replyLocalPart,
  runOfReply,
  tokenOfAgentLocalPart,
} from "./address";

const KEY = "k".repeat(32);
const RUN = "3f2a91c0-8c01-4d4e-9a1b-0123456789ab";

describe("inboundDomain", () => {
  it("is the domain, lowercased, only when the secret is set too", () => {
    expect(
      inboundDomain({
        INBOUND_EMAIL_DOMAIN: " Reply.Example.com ",
        RESEND_INBOUND_WEBHOOK_SECRET: "whsec_x",
      }),
    ).toBe("reply.example.com");
    expect(inboundDomain({ INBOUND_EMAIL_DOMAIN: "reply.example.com" })).toBeNull();
    expect(inboundDomain({ RESEND_INBOUND_WEBHOOK_SECRET: "whsec_x" })).toBeNull();
  });
});

describe("a report's reply address", () => {
  it("names its run, fits in a local part, and survives being lowercased or uppercased", async () => {
    const local = await replyLocalPart(KEY, RUN);
    expect(local).toMatch(/^r-[0-9a-f]{48}$/);
    expect(local.length).toBeLessThanOrEqual(64);
    expect(await runOfReply(KEY, local)).toBe(RUN);
    expect(await runOfReply(KEY, local.toUpperCase().replace(/^R-/, "r-"))).toBe(RUN);
  });

  it("is refused when the MAC, the run or the key differs", async () => {
    const local = await replyLocalPart(KEY, RUN);
    const flipped = local.slice(0, -1) + (local.endsWith("0") ? "1" : "0");
    expect(await runOfReply(KEY, flipped)).toBeNull();
    expect(await runOfReply("other".repeat(8), local)).toBeNull();
    expect(await runOfReply(KEY, "r-short")).toBeNull();
    expect(await runOfReply(KEY, "weekly-abcdefghijklmnop")).toBeNull();
  });
});

describe("a routine's own address", () => {
  it("has a readable name and a sixteen-character token", () => {
    const token = newAgentToken();
    expect(token).toMatch(AGENT_TOKEN);
    expect(newAgentToken()).not.toBe(token);
    expect(agentAddress("reply.example.com", "Haftalık Satış Özeti!", token)).toBe(
      `haftalik-satis-ozeti-${token}@reply.example.com`,
    );
    expect(addressName("!!!")).toBe("routine");
    expect(addressName("a very long routine name that keeps going")).toHaveLength(24);
  });

  it("is found again from its local part, by the token alone", () => {
    expect(tokenOfAgentLocalPart("weekly-digest-abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(tokenOfAgentLocalPart("ANYTHING-ABCDEFGHIJKLMNOP")).toBe("abcdefghijklmnop");
    expect(tokenOfAgentLocalPart("weekly-digest")).toBeNull();
  });
});

describe("reading addresses", () => {
  it("takes the address out of a display name, lowercased", () => {
    expect(addressOf('"Ayşe Demir" <Ayse@Example.com>')).toBe("ayse@example.com");
    expect(addressOf(" ayse@example.com ")).toBe("ayse@example.com");
  });

  it("finds each local part on our domain once, and nothing on others", () => {
    expect(
      localPartsOn("reply.example.com", [
        "Weekly <weekly-abc@reply.example.com>",
        "weekly-abc@REPLY.example.com",
        "someone@example.com",
        "x@sub.reply.example.com",
      ]),
    ).toEqual(["weekly-abc"]);
  });
});
