import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ReportWriter } from "@/lib/use-report";
import { useTranslation } from "@/i18n";

/**
 * "Write a report" (A25), opened from the composer's "+" or the thread's
 * menu — or by typing /report in the message box.
 *
 * Not drawn for a viewer: a report is a document written into what the
 * workspace shares, and `can_write_in_workspace` refuses it.
 *
 * It asks for an instruction rather than acting on the conversation alone. A
 * conversation is rarely about only one thing, and "write this up" leaves the
 * model to guess which part of it the report is; one sentence of intent is the
 * difference between a summary and a document somebody asked for.
 */
export function ReportDialog({ reports, canWrite }: { reports: ReportWriter; canWrite: boolean }) {
  const { t } = useTranslation();
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
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("Write a report")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="report-instruction">{t("What should the report cover?")}</Label>
          <Textarea
            id="report-instruction"
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t("Write up the quarter for the board, with the revenue numbers.")}
          />
          {/* Said before the wait rather than after it: where it lands and how
              long it takes are both easier to accept as a description than as
              a surprise. */}
          <p className="text-meta text-muted-foreground">
            {t(
              "Written section by section from this thread and what the agent reads, then filed in its reports folder. You can close the tab while it is written.",
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={submit} disabled={reports.pending || instruction.trim().length === 0}>
            {reports.pending ? t("Starting…") : t("Write report")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
