import { describe, it, expect } from "vitest";
import { securityHeaders } from "./start";

// securityHeaders is a TanStack Start request middleware; `.options.server`
// is the raw handler it was built with, so it can be invoked directly
// without spinning up the request pipeline. `next()` resolves to a
// RequestServerResult ({ request, pathname, context, response }), not a bare
// Response — the handler's declared return type is a union of the two
// because a middleware is allowed to return either, so the `"response" in`
// check below narrows to the shape this middleware actually produces.
const callMiddleware = async (response: Response) => {
  const result = await securityHeaders.options.server!({
    request: new Request("https://example.com"),
    pathname: "/",
    context: undefined,
    handlerType: "router",
    next: (async () => ({
      request: new Request("https://example.com"),
      pathname: "/",
      context: undefined,
      response,
    })) as never,
  });
  if (!("response" in result)) throw new Error("expected a RequestServerResult");
  return result.response;
};

describe("securityHeaders", () => {
  it("stamps framing and content-type headers on the response from next()", async () => {
    const response = await callMiddleware(new Response("ok"));

    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("does not swallow the response next() returned", async () => {
    const upstream = new Response("hello", { status: 201 });
    const response = await callMiddleware(upstream);

    expect(response).toBe(upstream);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hello");
  });
});
