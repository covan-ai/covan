import { Archive } from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { SectionHeading } from "@/components/page-container";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Routine, UpdateRoutineInput } from "@/lib/routines-api";

/** The sentinel for "keep nothing", because a Select cannot hold null. */
const NONE = "none";

/**
 * How many filed documents to keep.
 *
 * A few choices rather than a number field, described in weeks rather than in
 * documents, because the number on its own answers the wrong question: nobody
 * wants "52 documents", they want "about a year". Which of those two a number
 * means depends on the schedule, so the label says what the common case works
 * out to and the number stays exact.
 */
const RETENTIONS = [
  { value: 12, label: "12 — about three months of weekly" },
  { value: 26, label: "26 — about six months of weekly" },
  { value: 52, label: "52 — about a year of weekly" },
  { value: 104, label: "104 — about two years of weekly" },
] as const;

/**
 * Where a routine keeps what it sends.
 *
 * The difference between a routine that mails you and one that accumulates.
 * Fifty-two weekly digests in a bundle are a year of history an agent can be
 * asked a question of, which is a question no channel answers.
 *
 * Presentational, like the rest of this screen: the bundles and the agent's
 * attachments are passed in rather than fetched, so this file has nothing to
 * say about loading and can be rendered in a test without a store.
 *
 * Owner only, decided by the caller. Filing is a WRITE into the workspace's
 * knowledge — `can_write_in_workspace` rather than the routine's own visibility
 * — and the engine checks the owner's role again at run time, because a person
 * can be demoted long after they set this up.
 */
export function RoutineOutputCard({
  routine,
  bundles,
  /** The bundles this routine's agent reads. Only used to say so, below. */
  attachedBundleIds,
  canWrite,
  onSave,
  saving,
}: {
  routine: Routine;
  bundles: Array<{ id: string; name: string }>;
  attachedBundleIds: string[];
  /**
   * Whether the caller may write to this workspace's knowledge at all.
   *
   * Not a permission this component enforces — the database lets a viewer set
   * the column, and the engine is what refuses at run time. It is here so the
   * card does not make a claim the run will not honour: "every run files one
   * document" is simply untrue for a viewer, and finding that out from a note
   * in the run history a week later is the wrong way round.
   */
  canWrite: boolean;
  onSave: (patch: UpdateRoutineInput) => void;
  saving: boolean;
}) {
  const selected = routine.outputBundleId;
  const bundle = bundles.find((b) => b.id === selected);

  // Whether the agent this routine belongs to also reads the bundle it writes
  // to. Said plainly rather than prevented: it is a reasonable thing to want —
  // a digest that knows what it said last week — and it is also the one
  // arrangement in which a routine reads its own output back.
  const readsItsOwnOutput = selected !== null && attachedBundleIds.includes(selected);

  return (
    <section className="mt-10">
      <SectionHeading
        title="Keep a copy"
        description="File each delivered summary into a bundle, so the agent can be asked about it later."
      />

      <SectionCard className="mt-3 space-y-4">
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground" htmlFor="routine-output-bundle">
            Bundle
          </label>
          <Select
            value={selected ?? NONE}
            onValueChange={(value) => onSave({ outputBundleId: value === NONE ? null : value })}
            disabled={saving}
          >
            <SelectTrigger id="routine-output-bundle" className="w-full">
              <SelectValue placeholder="Keep nothing" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Keep nothing</SelectItem>
              {bundles.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selected === null ? (
          <p className="text-sm text-muted-foreground">
            Each run is delivered and then forgotten — the run history keeps the text it sent, and
            nothing else does.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground" htmlFor="routine-output-retention">
                Keep the last
              </label>
              <Select
                value={String(routine.outputRetention)}
                onValueChange={(value) => onSave({ outputRetention: Number(value) })}
                disabled={saving}
              >
                <SelectTrigger id="routine-output-retention" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTIONS.map((r) => (
                    <SelectItem key={r.value} value={String(r.value)}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="flex items-start gap-2 text-sm">
              <Archive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              {canWrite ? (
                <span>
                  Every run that delivers something files one document into{" "}
                  <strong className="font-medium">{bundle?.name ?? "that bundle"}</strong>, named
                  after this routine and the day. Older ones are removed once there are more than{" "}
                  {routine.outputRetention}.
                </span>
              ) : (
                <span>
                  You are a viewer, so nothing is filed — runs deliver as usual, and the setting
                  starts working if your role changes.
                </span>
              )}
            </p>

            {readsItsOwnOutput && (
              <p className="text-xs text-muted-foreground">
                This bundle is also attached to this routine's agent, so later runs will read what
                earlier ones wrote.
              </p>
            )}
          </>
        )}
      </SectionCard>
    </section>
  );
}
