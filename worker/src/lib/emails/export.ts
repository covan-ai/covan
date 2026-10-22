import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/** "184 MB", for a person reading an email rather than a byte count. */
export function readableSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * "The link is emailed to you and works for 7 days" (A27). The link opens
 * Settings › Export and deletion, which downloads it for a signed-in
 * requester: the file holds their private threads, so the email carries no
 * credential of its own.
 */
export function exportReadyEmail(args: {
  email: string;
  workspaceName: string;
  sizeBytes: number;
  expiresOn: string;
  url: string;
}) {
  const size = readableSize(args.sizeBytes);
  return {
    to: args.email,
    subject: `Your export of ${args.workspaceName} is ready`,
    text: [
      `The export you asked for is ready: ${size}, everything you can see in ${args.workspaceName}.`,
      "",
      `Download it here, signed in as yourself, until ${args.expiresOn}:`,
      args.url,
    ].join("\n"),
    html: emailShell({
      preheader: `${size}, ready until ${args.expiresOn}.`,
      heading: `Your export of ${args.workspaceName} is ready`,
      bodyHtml: paragraphs(
        `The export you asked for is ready: ${escapeHtml(size)}, everything you can see in ${escapeHtml(args.workspaceName)}.`,
        `It can be downloaded until ${escapeHtml(args.expiresOn)}, signed in as yourself.`,
      ),
      action: { label: "Download the export", url: args.url },
    }),
  };
}
