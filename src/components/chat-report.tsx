import { useState } from "react";
import { FileText, ScrollText, X } from "lucide-react";
import { Chip } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ReportWriter } from "@/lib/use-report";

/**
 * The write-a-report control in the chat composer.
 *
 * Hidden from a viewer rather than disabled, the same way the attach control
 * is: a report is a document written into what the workspace shares, and
 * `can_write_in_workspace` refuses it — so the control would be a promise the
 * database breaks.
 *
 * It asks for an instruction rather than acting on the conversation alone. A
 * conversation is rarely about only one thing, and "write this up" leaves the
 * model to guess which part of it the report is; one sentence of intent is the
 * difference between a summary and a document somebody asked for.
 *
 * Split from `ChatReportReceipt` because the two sit in different parts of the
 * composer — the button on the bottom row beside send, the receipt above the
 * text being typed.
 */
export function ChatReport({ reports, canWrite }: { reports: ReportWriter; canWrite: boolean }) {
  const { dialogOpen, setDialogOpen } = reports;
  const [instruction, setInstruction] = useState("");

  if (!canWrite) return null;

  const submit = () => {
    const text = instruction.trim();
    if (!text || reports.pending) return;
    setDialogOpen(false);
    setInstruction("");
    void reports.write(text);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Write a report from this conversation"
        title="Write a report from this conversation — or type /report in the message box"
      >
        <ScrollText className="h-4 w-4" />
      </button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Write a report</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="report-instruction">What should the report cover?</Label>
            <Textarea
              id="report-instruction"
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Write up the quarter for the board, with the revenue numbers."
            />
            {/* Said before the wait rather than after it. The report lands in
                the agent's knowledge as a document, and it lands unindexed —
                both are easier to accept as a description than as a surprise. */}
            <p className="text-xs text-muted-foreground">
              Lands as a document in this agent&rsquo;s reports bundle, grounded in the conversation
              and its knowledge. It arrives unindexed — reindex it on the Knowledge tab if the agent
              should be able to search it later. Takes up to a minute.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={reports.pending || instruction.trim().length === 0}>
              {reports.pending ? "Writing…" : "Write report"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What the last report became, kept above the composer.
 *
 * Two things here outlive a toast: the name it was filed under, which is how
 * anyone finds it again, and whether it is retrievable — a report with no
 * embeddings is a document the agent can be handed but cannot search, and
 * assuming otherwise is the quiet way to misread the next answer.
 */
export function ChatReportReceipt({ reports }: { reports: ReportWriter }) {
  const { receipt } = reports;
  if (!receipt) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-2.5">
      <div className="flex max-w-full items-center gap-2 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={reports.download}
          className="truncate font-medium hover:underline"
          aria-label={`Download ${receipt.name}`}
        >
          {receipt.name}
        </button>
        {receipt.indexed ? (
          <Chip tone="on">Indexed</Chip>
        ) : (
          <span title="No embeddings, so the agent cannot search inside it yet. Reindex it on the Knowledge tab.">
            <Chip tone="neutral">Not indexed</Chip>
          </span>
        )}
        <button
          type="button"
          onClick={reports.dismiss}
          className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
          aria-label={`Dismiss ${receipt.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
