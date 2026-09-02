import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { KNOWLEDGE_TEMPLATES, type KnowledgeTemplate } from "@/lib/knowledge-templates";
import { SectionHeading } from "@/components/page-container";

/**
 * "What am I supposed to upload?", answered with something you can fill in.
 *
 * The Knowledge tab is honest about which file types it accepts and says
 * nothing about what belongs in one, which is fine for a team with a drive full
 * of documents and useless for the team that has written nothing down yet. The
 * gap was reported by somebody evaluating Covan with an empty startup behind
 * them: the docs page did not make the shape of a good document clear, and what
 * they asked for was example formats to fill in and upload.
 *
 * Downloads, never uploads — `src/lib/knowledge-templates.ts` has the argument.
 *
 * `FirstUploads` next door answers the same question one step earlier and for a
 * different reader: it names four documents a team already has, which is the
 * right answer when the files exist and nobody has thought to upload them. This
 * one is for the team that goes looking and finds nothing — a startup two months
 * old with everything still in people's heads. Both are on this tab; neither
 * replaces the other, and the copy below says which case it is for so they do
 * not read as the same advice given twice.
 *
 * Open by default only when the agent has nothing, because that is the state
 * this exists for; once there are documents it collapses to one line and stops
 * competing with them.
 */
export function KnowledgeTemplates({ openByDefault }: { openByDefault: boolean }) {
  const [open, setOpen] = useState(openByDefault);

  return (
    <section className="mt-10">
      <SectionHeading title="Nothing to upload yet?" />
      <p className="mt-2 text-sm text-muted-foreground">
        If the files above do not exist yet — nothing written down, everything still in people's
        heads — these six are the ones that make an agent useful fastest. Download one, fill in the
        prompts, and drop it back in: a filled-in page of your own words is worth more than a
        polished document about somebody else's product.
      </p>

      {open ? (
        <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border border-border bg-surface">
          {KNOWLEDGE_TEMPLATES.map((template) => (
            <div
              key={template.filename}
              className="flex items-center gap-3 px-5 py-3.5 text-sm transition-colors duration-200 hover:bg-surface-hover"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{template.title}</div>
                <div className="text-xs text-muted-foreground">{template.blurb}</div>
              </div>
              <button
                type="button"
                onClick={() => downloadTemplate(template)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
                aria-label={`Download ${template.filename}`}
              >
                <Download className="h-3.5 w-3.5" />
                {template.filename}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
        >
          Show the six templates
        </button>
      )}
    </section>
  );
}

/**
 * Hand the browser a file it never fetched.
 *
 * A blob URL rather than a `data:` one: a data URL of this size is fine, but it
 * lands in the address bar on some browsers and is subject to the page's CSP,
 * where an object URL is neither. Revoked on the next frame — revoking in the
 * same tick cancels the download in Safari, which reads the URL after the click
 * handler returns.
 */
function downloadTemplate(template: KnowledgeTemplate): void {
  const url = URL.createObjectURL(
    new Blob([template.body], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = template.filename;
  link.click();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
