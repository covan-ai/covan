import { describe, expect, it } from "vitest";
import { app } from "./index";
import type { Bindings } from "./types";

/**
 * Which pages may read this API's answers with the caller's credentials.
 *
 * Any program on somebody's machine can serve a page on `http://localhost`, so
 * a deployed API that reflected every localhost origin was trusting whatever
 * else they happened to be running. Localhost is reflected only when the
 * deployment is itself a local one.
 */
async function allowedFor(origin: string, allowed: string): Promise<string | null> {
  const res = await app.request(
    "/health",
    { headers: { Origin: origin, "CF-Connecting-IP": crypto.randomUUID() } },
    { ALLOWED_ORIGIN: allowed } as Bindings,
  );
  return res.headers.get("Access-Control-Allow-Origin");
}

describe("CORS", () => {
  it("reflects an origin on the list", async () => {
    expect(await allowedFor("https://covan.app", "https://covan.app")).toBe("https://covan.app");
  });

  it("does not reflect localhost to a deployed API", async () => {
    expect(await allowedFor("http://localhost:5555", "https://covan.app")).toBe(
      "https://covan.app",
    );
  });

  it("reflects any localhost port when the deployment is local", async () => {
    expect(await allowedFor("http://localhost:5174", "http://localhost:3000")).toBe(
      "http://localhost:5174",
    );
  });

  it("never reflects a lookalike of localhost", async () => {
    expect(await allowedFor("http://localhost.evil.test", "http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  // The export names its file in Content-Disposition, which a browser hides
  // from a cross-origin page unless the API says it may read it.
  it("lets the page read the file name a download carries", async () => {
    const res = await app.request(
      "/health",
      { headers: { Origin: "https://covan.app", "CF-Connecting-IP": crypto.randomUUID() } },
      { ALLOWED_ORIGIN: "https://covan.app" } as Bindings,
    );
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Content-Disposition");
  });
});
