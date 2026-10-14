import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { reportOnlyPolicy } from "./lib/csp";

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
export const securityHeaders = createMiddleware().server(async ({ next, request }) => {
  const result = await next();
  result.response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  result.response.headers.set("X-Frame-Options", "DENY");
  result.response.headers.set("X-Content-Type-Options", "nosniff");
  result.response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Watched before it is enforced; see `lib/csp.ts`.
  result.response.headers.set(
    "Content-Security-Policy-Report-Only",
    reportOnlyPolicy({
      apiUrl: import.meta.env.VITE_API_URL,
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      posthogHost: import.meta.env.VITE_POSTHOG_HOST,
    }),
  );
  // Only over https, where a browser honours it; a self-hosted stack on
  // http://localhost gets nothing it would have ignored anyway. No
  // includeSubDomains: an operator's other subdomains are not ours to pin.
  if (new URL(request.url).protocol === "https:") {
    result.response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, errorMiddleware],
}));
