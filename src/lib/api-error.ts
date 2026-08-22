/**
 * What to tell a person when the API refuses.
 *
 * Shared by both transports — the JSON helper and the multipart upload — because
 * the same refusal reaching a person as prose down one path and as `quota_exceeded`
 * down the other is the kind of difference nobody notices until someone is
 * looking at it.
 */
export function errorMessage(status: number, body: unknown, fallback: string): string {
  const shape = body as { error?: unknown; resetsAt?: unknown } | null | undefined;
  const stated = typeof shape?.error === "string" ? shape.error : null;

  // 402 is the one refusal with a machine-readable shape, and its `error` field
  // is a code rather than a sentence. Turned into prose here so every caller
  // reports it the same way without knowing about quotas.
  if (status === 402 && stated === "quota_exceeded") {
    const resets =
      typeof shape?.resetsAt === "string"
        ? new Date(shape.resetsAt).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
          })
        : null;
    return resets
      ? `You've used this month's allowance. It resets on ${resets}.`
      : "You've used this month's allowance.";
  }

  return stated ?? fallback;
}
