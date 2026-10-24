import { canFileDocuments } from "../../../types";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import { affordable } from "../spend";
import { mayChangeThings } from "../role";
import {
  MAX_EDITABLE_CHARS,
  READ_PAGE_CHARS,
  applyEdits,
  editableInPlace,
  findAgentDocument,
  listAgentDocuments,
  readDocumentText,
  saveDocumentText,
  type Edit,
  type FoundDocument,
} from "../../docs/edit";

/**
 * The documents an agent can see, as documents rather than as passages.
 *
 * `search_documents` answers "which passages match"; nothing answered "what is
 * in this file" or "change this line in it", so an agent asked to revise a
 * report it had written wrote a new one from scratch. These three are that
 * road: find a document, read it whole, edit it where it lies. The rules for
 * what may be changed, and how, are in `lib/docs/edit.ts`.
 */

const LIST_LIMIT = 50;
const MAX_EDITS = 20;
const MAX_REPLACEMENT_CHARS = 60_000;

/** Reads whatever a document is stored in. Present on the API Worker, not on the cron one. */
const hasStore = (env: ToolEnv) => canFileDocuments(env);

function describe(doc: FoundDocument): string {
  const where = doc.bundle_name ? `, in ${doc.bundle_name}` : "";
  const size = typeof doc.size === "number" ? `, ${formatSize(doc.size)}` : "";
  const editable = editableInPlace(doc) ? "editable" : "read-only original (edits make a copy)";
  return `- ${doc.name} (id: ${doc.id}${where}${size}, ${editable})`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function asker(ctx: ToolContext) {
  return {
    db: ctx.db,
    agentId: ctx.agentId,
    workspaceId: ctx.workspaceId,
    knowledgeScope: ctx.knowledgeScope,
  };
}

export const listDocumentsTool: AgentTool = {
  name: "list_documents",
  description:
    "List the documents in your knowledge — uploads, files dropped into chats, reports you " +
    "wrote — with their ids, newest first. Use it to find the document somebody means before " +
    "reading or editing it. Optionally narrow by part of the name.",
  input: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Part of the document's name to filter by. Leave out to list them all.",
      },
    },
    additionalProperties: false,
  },
  destructive: false,
  isConfigured: (_env: ToolEnv) => true,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const name = (args as { name?: unknown } | null)?.name;
    const query = typeof name === "string" && name.trim() ? name.trim() : null;
    const docs = await listAgentDocuments(asker(ctx), query, LIST_LIMIT);
    if (docs.length === 0) {
      return {
        kind: "ok",
        content: query
          ? `No document in your knowledge has a name containing "${query}".`
          : "No documents are in your knowledge in this conversation.",
      };
    }
    const more =
      docs.length === LIST_LIMIT
        ? `\n(The newest ${LIST_LIMIT}; narrow by name to find older ones.)`
        : "";
    return { kind: "ok", content: `${docs.map(describe).join("\n")}${more}` };
  },
};

export const readDocumentTool: AgentTool = {
  name: "read_document",
  description:
    "Read a document from your knowledge in full, by its id (from list_documents or the " +
    "conversation) or its name. Use it when you need the whole text rather than matching " +
    "passages — to summarise, check or compare a document, and always before editing one. " +
    `Long documents come back ${READ_PAGE_CHARS.toLocaleString("en")} characters at a time; ` +
    "pass offset to read on.",
  input: {
    type: "object",
    properties: {
      document: { type: "string", description: "The document's id, or its name." },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Character to start from, for the next part of a long document.",
      },
    },
    required: ["document"],
    additionalProperties: false,
  },
  destructive: false,
  isConfigured: hasStore,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const record = (args ?? {}) as { document?: unknown; offset?: unknown };
    const ref = typeof record.document === "string" ? record.document : "";
    const offset =
      typeof record.offset === "number" && Number.isFinite(record.offset)
        ? Math.max(0, Math.floor(record.offset))
        : 0;
    if (!canFileDocuments(ctx.env)) {
      return { kind: "error", message: "documents cannot be read whole on this deployment" };
    }

    const found = await findAgentDocument(asker(ctx), ref);
    if (found.kind !== "found") return { kind: "error", message: found.message };
    const doc = found.doc;

    const read = await readDocumentText(ctx.env, doc, offset + READ_PAGE_CHARS);
    if (read.kind === "error") return { kind: "error", message: read.message };
    const page = read.text.slice(offset);
    if (!page && offset > 0) {
      return { kind: "ok", content: `"${doc.name}" ends before character ${offset}.` };
    }
    const end = offset + page.length;
    const header =
      `Document "${doc.name}" (id: ${doc.id}${doc.bundle_name ? `, in ${doc.bundle_name}` : ""}), ` +
      (offset > 0 || read.truncated
        ? `characters ${offset}–${end}${read.truncated ? ", continues" : ", the end"}`
        : "the whole text") +
      (editableInPlace(doc)
        ? ""
        : ". Its original is not plain text: an edit saves a Markdown copy");
    const footer = read.truncated
      ? `\n\n[More follows. Call read_document again with offset ${end} to read on.]`
      : "";
    return { kind: "ok", content: `${header}:\n\n${page}${footer}` };
  },
};

export const editDocumentTool: AgentTool = {
  name: "edit_document",
  description:
    "Change a document that already exists in your knowledge, instead of writing a new one. " +
    "Use it whenever somebody asks to fix, update, extend, shorten, translate or reword a " +
    "document — including one you wrote with write_document. Read it first with " +
    "read_document. Give `edits`: each replaces one exact piece of the current text (copied " +
    "character for character, long enough to be unique) with new text; to add something, " +
    "find the text it goes after and replace it with that text plus the addition. For a " +
    "complete rewrite of a short document, give `content` with the whole new text instead. " +
    "Markdown and text files are changed in place and re-indexed; a Word, PDF or synced " +
    "document is left untouched and an edited Markdown copy is saved beside it. Afterwards " +
    "tell the person in a sentence what changed.",
  input: {
    type: "object",
    properties: {
      document: { type: "string", description: "The document's id, or its name." },
      edits: {
        type: "array",
        maxItems: MAX_EDITS,
        description: "Exact replacements, applied in order.",
        items: {
          type: "object",
          properties: {
            find: {
              type: "string",
              description: "Text that appears in the document exactly as written here.",
            },
            replace: { type: "string", description: "What it becomes. Empty to delete it." },
            all: {
              type: "boolean",
              description: "Replace every occurrence rather than requiring exactly one.",
            },
          },
          required: ["find", "replace"],
          additionalProperties: false,
        },
      },
      content: {
        type: "string",
        description: "The whole new text, replacing everything. Only for a full rewrite.",
      },
    },
    required: ["document"],
    additionalProperties: false,
  },
  destructive: false,
  isConfigured: hasStore,
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const record = (args ?? {}) as { document?: unknown; edits?: unknown; content?: unknown };
    const ref = typeof record.document === "string" ? record.document : "";
    const edits = parseEdits(record.edits);
    if (edits.kind === "error") return edits;
    const content = typeof record.content === "string" ? record.content : null;
    if (edits.list.length === 0 && content === null) {
      return { kind: "error", message: "give edits, or content for a full rewrite" };
    }
    if (edits.list.length > 0 && content !== null) {
      return { kind: "error", message: "give edits or content, not both" };
    }
    if (content !== null && !content.trim()) {
      return {
        kind: "error",
        message: "content is empty. To remove a document the person deletes it in Knowledge.",
      };
    }
    if (!canFileDocuments(ctx.env)) {
      return { kind: "error", message: "documents cannot be changed on this deployment" };
    }

    const refused = await affordable(ctx);
    if (refused) return refused;
    if (!(await mayChangeThings(ctx))) {
      return {
        kind: "error",
        message:
          "the person you are working for is a viewer in this workspace and cannot change " +
          "documents. Say so plainly; offer the change as text in the chat instead.",
      };
    }

    const found = await findAgentDocument(asker(ctx), ref);
    if (found.kind !== "found") return { kind: "error", message: found.message };
    const doc = found.doc;

    let next: string;
    let changed = 0;
    if (content !== null) {
      next = content;
    } else {
      const read = await readDocumentText(ctx.env, doc, MAX_EDITABLE_CHARS);
      if (read.kind === "error") return { kind: "error", message: read.message };
      if (read.truncated) {
        return {
          kind: "error",
          message:
            `"${doc.name}" is longer than ${MAX_EDITABLE_CHARS.toLocaleString("en")} characters, ` +
            "too long to edit here. Tell the person; suggest they edit the file and upload it again.",
        };
      }
      const applied = applyEdits(read.text, edits.list);
      if (applied.kind === "error") return { kind: "error", message: applied.message };
      next = applied.text;
      changed = applied.changed;
    }
    if (next.length > MAX_EDITABLE_CHARS) {
      return { kind: "error", message: "the edited document would be too long to save" };
    }

    const saved = await saveDocumentText({ ...asker(ctx), env: ctx.env }, doc, next);
    if (saved.kind === "error") return { kind: "error", message: saved.message };

    const what =
      content !== null ? "rewritten" : `changed in ${changed} place${changed === 1 ? "" : "s"}`;
    if (saved.kind === "copied") {
      return {
        kind: "ok",
        content:
          `"${doc.name}" cannot be changed in place, so the edited version was saved beside it ` +
          `as "${saved.name}" (id: ${saved.documentId}), ${what}. The original is unchanged. ` +
          "It is being indexed and will be searchable in a moment. Tell the person where it is.",
      };
    }
    return {
      kind: "ok",
      content:
        `"${doc.name}" (id: ${doc.id}) was ${what} and saved. It is being re-indexed, so ` +
        "searches find the new text in a moment. Tell the person briefly what changed; do not " +
        "paste the whole document back.",
    };
  },
};

function parseEdits(
  value: unknown,
): { kind: "ok"; list: Edit[] } | { kind: "error"; message: string } {
  if (value === undefined || value === null) return { kind: "ok", list: [] };
  if (!Array.isArray(value)) return { kind: "error", message: "edits must be a list" };
  if (value.length > MAX_EDITS) {
    return { kind: "error", message: `at most ${MAX_EDITS} edits at a time` };
  }
  const list: Edit[] = [];
  for (const [i, item] of value.entries()) {
    const e = (item ?? {}) as { find?: unknown; replace?: unknown; all?: unknown };
    if (typeof e.find !== "string" || typeof e.replace !== "string") {
      return { kind: "error", message: `edit ${i + 1} needs find and replace as text` };
    }
    if (e.replace.length > MAX_REPLACEMENT_CHARS) {
      return { kind: "error", message: `edit ${i + 1}'s replacement is too long` };
    }
    list.push({ find: e.find, replace: e.replace, all: e.all === true });
  }
  return { kind: "ok", list };
}
