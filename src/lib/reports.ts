// Where a report written from a conversation lands — the agent's reports
// bundle, marked `covan:reports:<agentId>` in its description — is decided on
// the server now (`worker/src/lib/docs/bundle.ts`), because the agent can ask
// for a document from a tool with no browser in the loop. What is left here is
// the command.

/**
 * Asking for a report without leaving the message box.
 *
 * The composer button is the discoverable way in and this is the fast one, for
 * the person who already knows what they want and does not want a dialog
 * between them and typing it. Deliberately a typed command rather than the
 * model noticing that a message sounds like a request for a report: a
 * misjudged one costs a minute of waiting and answers a question with a file.
 *
 * The command is `/report` in every language, the way `git commit` is — what
 * follows it is the instruction and is written in whatever language the person
 * thinks in.
 */
const COMMAND = /^\/report(?:[ \t\n]+([\s\S]*))?$/i;

/**
 * The instruction in a `/report …` message, or null if this is just a message.
 *
 * An empty instruction is not the same answer as null, and callers act on the
 * difference: null sends the line as an ordinary message, `""` means the person
 * asked for a report and has not said what about — which is exactly what the
 * dialog is for.
 */
export function parseReportCommand(text: string): { instruction: string } | null {
  const match = text.trim().match(COMMAND);
  if (!match) return null;
  return { instruction: (match[1] ?? "").trim() };
}

/**
 * A folder's description as a person should read it.
 *
 * An agent's reports folder carries `covan:reports:<agentId>` in its
 * description — the server finds the folder by it (`worker/src/lib/docs/
 * bundle.ts`) — and the explorer printed that key beside the folder's name.
 * It is a marker, not a description, so it reads as none.
 */
export function folderDescription(description: string | null | undefined): string | null {
  if (!description || description.startsWith("covan:reports:")) return null;
  return description;
}
