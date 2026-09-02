import { SectionCard } from "@/components/section-card";

/**
 * What to put in the first bundle.
 *
 * A workspace with no bundles is the one screen where the product is
 * indistinguishable from a chat window, and the honest reason is that nobody
 * has told it anything yet. `EmptyState` is the right treatment for a list that
 * happens to be empty; it is the wrong one here, because there is a specific
 * answer to "what now" and printing "no bundles yet" withholds it (covan#45).
 *
 * The four below are not categories, they are files a team already has. Each
 * carries the reason it earns a place, because "upload your documentation" is
 * advice nobody can act on and "the page that says how expenses work" is.
 *
 * Only shown to somebody who can actually upload. A viewer looking at an empty
 * workspace gets the plain empty state — a checklist you are not allowed to
 * complete is worse than a blank.
 */

const FIRST_UPLOADS: Array<{ what: string; why: string }> = [
  {
    what: "The handbook",
    why: "Leave, expenses, hours, who approves what. These are the questions asked out loud, by the person least willing to ask twice.",
  },
  {
    what: "The tooling pages",
    why: "Which tool for what, and who owns it. Half of a first week is finding out where things live.",
  },
  {
    what: "However you do the thing you do",
    why: "A release, a refund, a proposal, a handover. This is the knowledge that usually lives in one person's head and leaves with them.",
  },
  {
    what: "The answer you have typed twice",
    why: "If you have written it out for two different people, it is documentation that has not been filed yet.",
  },
];

export function FirstUploads({ className }: { className?: string }) {
  return (
    <SectionCard className={className}>
      <p className="font-dm text-[18px] leading-tight">Start with four files</p>
      <p className="mt-2 max-w-prose text-sm leading-[1.45] text-muted-foreground">
        A bundle is a group of documents any agent can read. It is worth more than the sum of the
        files in it once it covers the questions people actually ask, so start with the ones they
        already do.
      </p>
      <ul className="mt-5 space-y-3.5">
        {FIRST_UPLOADS.map((item) => (
          <li key={item.what} className="flex gap-3">
            {/* Square, per the system: bullets, marks and selection markers are
                never round. Nudged down to sit on the first line's baseline
                rather than its box. */}
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 bg-muted-foreground" />
            <p className="text-sm leading-[1.45]">
              <span className="font-medium">{item.what}</span>
              <span className="text-muted-foreground"> — {item.why}</span>
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
