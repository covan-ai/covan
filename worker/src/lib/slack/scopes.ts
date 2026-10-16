/**
 * What the Slack app asks for when it is installed, and which of it each
 * thing the app does depends on.
 *
 * Here rather than in `routes/slack.ts` because two places read it: the install
 * route, which asks Slack for all of it, and the event adapter
 * (`lib/routines/events/slack.ts`), which has to know whether an install made
 * before a scope was added can hear an event at all. Slack grants scopes per
 * install, so adding one here changes nothing for an existing workspace until
 * somebody there installs the app again — which is why the install records
 * what it was granted (`slack_installations.scopes`, 0112).
 */
export const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "im:history",
  "users:read",
  "users:read.email",
  // Routines that start on Slack activity (0112): a message in a public
  // channel, one in a private channel the app is in, and a reaction.
  "channels:history",
  "groups:history",
  "reactions:read",
] as const;

/** What a routine that starts on Slack activity needs the install to have. */
export const SCOPES_FOR_EVENTS = {
  message: ["channels:history", "groups:history"],
  reaction: ["reactions:read", "channels:history"],
} as const;

/**
 * Which of `wanted` an install lacks. A row from before 0112 has no record of
 * its scopes, and nothing before 0112 asked for these, so it lacks all of them.
 */
export function missingScopes(
  granted: readonly string[] | null,
  wanted: readonly string[],
): string[] {
  const have = new Set(granted ?? []);
  return wanted.filter((s) => !have.has(s));
}

/** Every scope the event features need that this install was not granted. */
export function missingEventScopes(granted: readonly string[] | null): string[] {
  return missingScopes(granted, [...new Set(Object.values(SCOPES_FOR_EVENTS).flat())]);
}
