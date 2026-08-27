import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// The session lives in localStorage, which a same-origin iframe reads
// normally — so a framed Covan is a fully authenticated one, with no
// SameSite cookie behaviour to intervene. Every destructive action is behind
// a confirm dialog, which stops the one-click version and not the two-click
// one.
export const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  result.response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  result.response.headers.set("X-Frame-Options", "DENY");
  result.response.headers.set("X-Content-Type-Options", "nosniff");
  result.response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, errorMiddleware],
}));
