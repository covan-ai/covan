import type { Bundle } from "./api-client";

// Where a report written from a conversation lands.
//
// The same shape as `chat-uploads.ts`, and for a related reason: a report has
// no obvious bundle either, and asking "which bundle should this go in?" before
// the report exists is asking about something nobody has read yet. So it goes
// to a bundle per agent, attached to that agent, and moving it somewhere
// curated stays available afterwards through the ordinary document move.
//
// It is a separate bundle from chat uploads rather than a shelf inside it,
// because the two hold opposite things. A chat upload is a source the agent was
// given; a report is something the agent produced. Keeping them apart is what
// lets someone detach the reports — so the agent stops reading its own output
// back as if it were evidence — without also detaching the files they uploaded.
//
// Identified by a marker in the description, not by name, for the reason the
// chat bundle is: names belong to the user, and renaming the agent or the
// bundle must not strand it and start a second one beside it.
const MARKER_PREFIX = "covan:reports:";

export function reportBundleMarker(agentId: string): string {
  return `${MARKER_PREFIX}${agentId}`;
}

export function reportBundleName(agentName: string): string {
  return `${agentName} — reports`;
}

/** This agent's report bundle, or null if no report has ever been written. */
export function findReportBundle(bundles: Bundle[], agentId: string): Bundle | null {
  const marker = reportBundleMarker(agentId);
  return bundles.find((b) => b.description === marker) ?? null;
}
