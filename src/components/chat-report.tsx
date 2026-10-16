import { useState } from "react";
import { ScrollText } from "lucide-react";
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
 * What it becomes is a document card in the conversation and the document
 * beside it, filling in section by section (`chat/document-card.tsx`,
 * `chat/document-panel.tsx`) — the same two things a document the agent
 * started itself becomes.
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
        className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Write a report from this conversation"
        title="Write a report from this conversation — or type /report in the message box"
      >
        <ScrollText className="h-[18px] w-[18px]" />
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
            {/* Said before the wait rather than after it: where it lands and how
                long it takes are both easier to accept as a description than as
                a surprise. */}
            <p className="text-xs text-muted-foreground">
              Written section by section beside the conversation, then filed in this agent&rsquo;s
              reports bundle. You can close the tab while it is written.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={reports.pending || instruction.trim().length === 0}>
              {reports.pending ? "Starting…" : "Write report"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
