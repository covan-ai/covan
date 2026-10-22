import { Button } from "@/components/ui/button";
import { EmptyWell } from "@/components/empty-page";
import { ACCEPTED_SUMMARY } from "@/lib/uploads";

/**
 * The empty screen of an agent that has nothing to read yet.
 *
 * It used to offer the same four starters as an agent with a library behind
 * it — "Summarize what you know" to an agent that knew nothing — and the
 * first answer a new workspace ever saw was "I couldn't find that". A tester
 * said the first minute is where a product earns its "oh, nice", and spent it
 * on a dead end. So when there is nothing indexed, the screen says the one
 * useful thing instead: add a document, here is how.
 *
 * Three answers to who is looking:
 *
 * - Somebody who can upload, in a private thread: the composer's own picker,
 *   opened from a button, plus the Knowledge tab for more than one file.
 * - The same person in a shared thread: the Knowledge tab only. A file picked
 *   here would land in their private chat folder, which a shared thread is
 *   answered without (`findChatBundle`, `KnowledgeScope.sharedOnly`), so the
 *   picker would promise grounding that cannot arrive.
 * - Somebody who cannot upload: a sentence, not a well. A call to action they
 *   cannot act on is worse than a blank.
 */
export function FirstDocument({
  agentName,
  canUpload,
  isShared,
  onPick,
  onKnowledge,
}: {
  agentName: string;
  canUpload: boolean;
  isShared: boolean;
  /** Opens the composer's file picker. */
  onPick: () => void;
  /** Goes to the agent's Knowledge tab. */
  onKnowledge: () => void;
}) {
  if (!canUpload) {
    return (
      <p className="text-sm text-muted-foreground">
        Nobody has added documents to {agentName} yet.
      </p>
    );
  }
  if (isShared) {
    return (
      <EmptyWell
        title="Upload your first document"
        description={`${agentName} answers from what your team uploads. A file added in a shared thread would go to your private folder, which a shared thread can't read — so add it on the Knowledge tab.`}
        actions={
          <Button variant="secondary" onClick={onKnowledge}>
            Add documents on the Knowledge tab
          </Button>
        }
      />
    );
  }
  return (
    <EmptyWell
      title="Upload your first document"
      description={`${agentName} answers from what your team uploads. ${ACCEPTED_SUMMARY}.`}
      actions={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* Secondary, not the amber fill: the one amber button on this
              screen is Send (DESIGN.md §4). */}
          <Button variant="secondary" onClick={onPick}>
            Upload a document
          </Button>
          <Button variant="link" onClick={onKnowledge}>
            Open the Knowledge tab
          </Button>
        </div>
      }
    />
  );
}
