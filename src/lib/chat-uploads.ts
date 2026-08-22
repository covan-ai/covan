import type { Bundle } from "./api-client";

// Where a file dropped into a conversation lands.
//
// A chat upload has nowhere obvious to go: bundles are the workspace's unit of
// knowledge and picking one is a decision the person dropping the file has not
// made yet — often cannot make yet, since whether the file was worth keeping is
// something you learn from the answer, not before it. So it goes to a bundle
// per agent, attached to that agent, and the decision is offered afterwards
// against something the user has already seen work.
//
// The bundle is identified by a marker written into its description rather than
// by its name. Names are the user's: renaming the agent, or the bundle, must
// not strand the bundle and start a second one beside it. The description is
// not rendered anywhere in the interface, so the marker stays out of sight.
const MARKER_PREFIX = "covan:chat-uploads:";

export function chatBundleMarker(agentId: string): string {
  return `${MARKER_PREFIX}${agentId}`;
}

export function chatBundleName(agentName: string): string {
  return `${agentName} — chat uploads`;
}

/** This agent's chat bundle, or null if nothing has ever been dropped into one. */
export function findChatBundle(bundles: Bundle[], agentId: string): Bundle | null {
  const marker = chatBundleMarker(agentId);
  return bundles.find((b) => b.description === marker) ?? null;
}
