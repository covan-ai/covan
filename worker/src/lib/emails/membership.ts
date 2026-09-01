import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * The two notes a person gets when somebody else changes what they may do.
 *
 * Both exist for the same reason. Losing a workspace, or being moved to a role
 * that cannot write, is not self-announcing: the product simply behaves
 * differently the next time it is opened — colleagues' agents are gone, or a
 * save comes back refused with no visible cause. Every other silent capability
 * change in this codebase has been treated as a bug worth fixing, and these are
 * the two the interface still made silently.
 *
 * Neither carries a button. There is nothing to click that would undo it, and a
 * link into a workspace somebody has just been removed from would be a door that
 * refuses them a second time.
 */
export function removedFromWorkspaceEmail(args: { email: string; workspaceName: string }) {
  return {
    to: args.email,
    subject: `You were removed from ${args.workspaceName} on Covan`,
    text: [
      `You no longer have access to ${args.workspaceName} on Covan.`,
      "",
      "Its agents and the documents they read are no longer visible to you, and",
      "any API keys you had stop working with it at the same moment.",
      "",
      "Your account itself is untouched: other workspaces you belong to still",
      "work, and your own conversations are still yours.",
      "",
      "If this was not expected, the people to ask are that workspace's admins.",
    ].join("\n"),
    html: emailShell({
      preheader: `You no longer have access to ${args.workspaceName}.`,
      heading: `You were removed from ${args.workspaceName}`,
      bodyHtml: paragraphs(
        "Its agents and the documents they read are no longer visible to you, and any API keys you had stop working with it at the same moment.",
        "Your account itself is untouched: other workspaces you belong to still work, and your own conversations are still yours.",
        "If this was not expected, the people to ask are that workspace's admins.",
      ),
    }),
  };
}

/**
 * A role change, described by what it lets somebody do rather than by its name.
 *
 * "You are now a viewer" means nothing to a person who has never read the docs.
 * What they need is the sentence after it, which is why each role carries its
 * own — and why the viewer line leads with what still works, since that is the
 * role people are most likely to read as a demotion and a shut door.
 */
const WHAT_IT_MEANS: Record<string, string> = {
  admin:
    "As an admin you can invite and remove people, change roles, and edit anything the workspace holds.",
  member:
    "As a member you can create and change agents, upload documents, and set up routines — everything except managing who is in the workspace.",
  viewer:
    "As a viewer you can still chat with every agent, ask about every document, and keep your own conversations and routines. What you cannot do is change the things the workspace shares: agents, uploads and the ideas board are read-only for you now.",
};

export function roleChangedEmail(args: { email: string; workspaceName: string; role: string }) {
  const meaning = WHAT_IT_MEANS[args.role] ?? `Your role in this workspace is now ${args.role}.`;
  return {
    to: args.email,
    subject: `Your role in ${args.workspaceName} changed`,
    text: [
      `An admin changed your role in ${args.workspaceName} to ${args.role}.`,
      "",
      meaning,
      "",
      "If this was not expected, the people to ask are that workspace's admins.",
    ].join("\n"),
    html: emailShell({
      preheader: `You are now ${args.role} in ${args.workspaceName}.`,
      heading: `Your role in ${args.workspaceName} changed`,
      bodyHtml: paragraphs(
        `An admin changed your role to <strong>${escapeHtml(args.role)}</strong>.`,
        meaning,
        "If this was not expected, the people to ask are that workspace's admins.",
      ),
    }),
  };
}
