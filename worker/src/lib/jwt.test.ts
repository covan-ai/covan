import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { signHs256, verifyAccessToken, resetJwks } from "./jwt";

const SECRET = "a-signing-secret-long-enough-to-be-plausible";
const URL_ = "https://project.supabase.co";

function claims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "11111111-2222-3333-4444-555555555555",
    email: "someone@example.com",
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An ES256 token, signed the way GoTrue signs one for a project with JWKS. */
async function signEs256(key: CryptoKey, kid: string, payload: object): Promise<string> {
  const seg = (v: object) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const body = `${seg({ alg: "ES256", typ: "JWT", kid })}.${seg(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

describe("verifying an access token without asking GoTrue", () => {
  beforeEach(() => resetJwks());
  afterEach(() => vi.unstubAllGlobals());

  describe("HS256 — the self-hosted stack", () => {
    const env = { SUPABASE_URL: URL_, SUPABASE_JWT_SECRET: SECRET };

    it("accepts a token signed with the deployment's secret", async () => {
      const verdict = await verifyAccessToken(env, await signHs256(SECRET, claims()));

      expect(verdict).toEqual({
        status: "valid",
        user: { id: "11111111-2222-3333-4444-555555555555", email: "someone@example.com" },
      });
    });

    it("refuses one signed with a different secret", async () => {
      const token = await signHs256("some-other-secret", claims());

      expect(await verifyAccessToken(env, token)).toEqual({ status: "invalid" });
    });

    it("refuses an expired token", async () => {
      const token = await signHs256(SECRET, claims({ exp: Math.floor(Date.now() / 1000) - 1 }));

      expect(await verifyAccessToken(env, token)).toEqual({ status: "invalid" });
    });

    it("refuses an audience that is not authenticated", async () => {
      // An anon key is signed with the same secret and is not a session.
      const token = await signHs256(SECRET, claims({ role: "anon", aud: "anon" }));

      expect(await verifyAccessToken(env, token)).toEqual({ status: "invalid" });
    });

    it("refuses a token with no subject", async () => {
      const token = await signHs256(SECRET, claims({ sub: "" }));

      expect(await verifyAccessToken(env, token)).toEqual({ status: "invalid" });
    });

    it("refuses something that is not a JWT at all", async () => {
      expect(await verifyAccessToken(env, "not.a.jwt")).toEqual({ status: "invalid" });
      expect(await verifyAccessToken(env, "onesegment")).toEqual({ status: "invalid" });
    });
  });

  describe("ES256 — a project with signing keys", () => {
    const env = { SUPABASE_URL: URL_ };
    const KID = "e6d6773f-7888-4f0f-a879-1a517c514a96";

    async function keypair(): Promise<CryptoKeyPair> {
      return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
    }

    async function serveJwks(publicKey: CryptoKey, kid = KID) {
      const jwk = await crypto.subtle.exportKey("jwk", publicKey);
      const fetchMock = vi.fn(async () =>
        Response.json({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] }),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("accepts a token signed by the key the project publishes", async () => {
      const { privateKey, publicKey } = await keypair();
      await serveJwks(publicKey);

      const verdict = await verifyAccessToken(env, await signEs256(privateKey, KID, claims()));

      expect(verdict).toEqual({
        status: "valid",
        user: { id: "11111111-2222-3333-4444-555555555555", email: "someone@example.com" },
      });
    });

    it("refuses a token signed by some other key", async () => {
      const mine = await keypair();
      const theirs = await keypair();
      await serveJwks(mine.publicKey);

      const token = await signEs256(theirs.privateKey, KID, claims());

      expect(await verifyAccessToken(env, token)).toEqual({ status: "invalid" });
    });

    it("fetches the key set once, not once per request", async () => {
      const { privateKey, publicKey } = await keypair();
      const fetchMock = await serveJwks(publicKey);

      const token = await signEs256(privateKey, KID, claims());
      await verifyAccessToken(env, token);
      await verifyAccessToken(env, token);
      await verifyAccessToken(env, token);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("gives up rather than guessing when the key set has no such kid", async () => {
      const { privateKey, publicKey } = await keypair();
      await serveJwks(publicKey, "a-different-kid");

      const token = await signEs256(privateKey, KID, claims());

      // Not "invalid": this deployment cannot tell, and the caller is expected
      // to ask GoTrue rather than turn a live session away.
      expect(await verifyAccessToken(env, token)).toEqual({ status: "unknown" });
    });

    it("gives up when the key set cannot be fetched", async () => {
      const { privateKey } = await keypair();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network");
        }),
      );

      const token = await signEs256(privateKey, KID, claims());

      expect(await verifyAccessToken(env, token)).toEqual({ status: "unknown" });
    });
  });

  it("gives up on an HS256 token when the deployment holds no secret", async () => {
    const token = await signHs256(SECRET, claims());

    expect(await verifyAccessToken({ SUPABASE_URL: URL_ }, token)).toEqual({ status: "unknown" });
  });
});
