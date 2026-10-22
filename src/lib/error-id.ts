import { ApiError } from "./api-error";

/**
 * The id a crash page shows (A31: "err_7f3k2m9q"), to read out to support.
 * From the API's request id when the error came from the API (every 5xx
 * carries one, B1), so the id finds the request in the Worker's logs;
 * otherwise eight random letters, written to the console beside the error.
 */
export function errorIdOf(error: unknown): string {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const fromRequest = requestId
    ?.replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase();
  if (fromRequest && fromRequest.length >= 6) return `err_${fromRequest}`;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `err_${Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("")}`;
}
