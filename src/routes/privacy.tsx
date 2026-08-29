import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalLayout, LegalSection, LegalList, LegalItem } from "@/components/legal-layout";

/**
 * What this software does with what you put into it.
 *
 * Written from the code rather than from a template, and deliberately not
 * written as a policy: a policy is a promise made by whoever is running the
 * install, and this repository is not running it. What a repository can state
 * truthfully is mechanism — which rows are stored, which hosts are called, and
 * with what. An operator running Covan as a service points
 * `VITE_TERMS_URL` / `VITE_PRIVACY_URL` at their own documents and this page
 * stops being linked (see `src/lib/legal.ts`).
 *
 * Every destination below is a real call in this codebase. If you add another
 * one, this page is part of the change.
 *
 * The same rule binds the other direction, and it is the one that broke: every
 * capability named below has to be a registered route, not a schema that would
 * allow one. This page claimed a whole workspace could be deleted from the
 * interface because `0016_deletable_users_and_workspaces.sql` made it deletable
 * — but that migration cleared the way, and nobody built the door. A page that
 * describes a permission as though it were a feature is wrong about the
 * product while being right about the database.
 */
export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: "Privacy — Covan" },
      { name: "description", content: "What Covan stores, and everywhere it sends your data." },
    ],
  }),
});

function PrivacyPage() {
  return (
    <LegalLayout title="Privacy" updated="August 2026">
      <p className="text-[15px] leading-[1.55] text-muted-foreground">
        Covan is open source, and this page describes what the software itself does — the data it
        stores and every outside service it calls. Whoever runs the install you are using controls
        that database and is responsible for it. If that is your own company, it is you.
      </p>

      <LegalSection title="What is stored">
        <LegalList>
          <LegalItem>
            <strong className="font-medium text-foreground">Your account</strong> — email address,
            display name, and a password hash. Authentication is handled by Supabase Auth; the plain
            password is never stored.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Documents you upload</strong> — the
            original file, plus the text extracted from it, split into passages and stored alongside
            a numeric embedding of each so that questions can find them.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Conversations</strong> — your messages,
            the replies, and which documents grounded each reply. Sessions are private to you and
            enforced that way in the database, not by a check in the API. A session becomes readable
            by your workspace only when you share it.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Usage counts</strong> — tokens spent per
            reply, used to show you what you have used and, on a metered install, to apply an
            allowance.
          </LegalItem>
        </LegalList>
      </LegalSection>

      <LegalSection title="Where it goes">
        <p>
          These are the only outside services the software contacts, and the last three are only
          contacted if the operator configured them.
        </p>
        <LegalList>
          <LegalItem>
            <strong className="font-medium text-foreground">OpenAI</strong> — your messages, the
            persona of the agent, and the passages retrieved from your documents are sent so a reply
            can be generated. Document text is sent when it is first indexed. Audio is sent when you
            dictate. This is the one call the product cannot work without.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Resend</strong> — invitation emails and
            the results of scheduled routines, when an email address is the destination.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Slack</strong> — the results of a
            routine, posted to a webhook URL you supply.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Pages a routine watches</strong> — a
            routine you point at a feed or a page fetches that address on its schedule.
          </LegalItem>
          <LegalItem>
            <strong className="font-medium text-foreground">Google Fonts</strong> — the two
            typefaces the interface uses are requested by your browser from{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[13px]">
              fonts.googleapis.com
            </code>
            .
          </LegalItem>
        </LegalList>
      </LegalSection>

      <LegalSection title="What there is none of">
        <p>
          No analytics, no tracking pixels, no advertising, no session recording, and no third-party
          script beyond the font stylesheet above. Covan does not sell anything to anyone, because
          there is nobody to sell it to: the software has no telephone home.
        </p>
      </LegalSection>

      <LegalSection title="Deleting things">
        <p>
          A document, a conversation and an agent can each be deleted from the interface, and
          deleting them removes the rows and the stored file rather than hiding them.
        </p>
        <p>
          A whole workspace cannot. You can leave one, and an admin can remove someone from one, but
          nothing in the interface deletes the workspace itself. The database is arranged so that it
          could be; the route to ask for it has not been written.
        </p>
        <p>
          Removing an account itself is not yet something the interface does either — that is a gap
          being closed, not a decision. Until it is, whoever operates the install can delete the
          user through Supabase, and the rows that belong to them go with it.
        </p>
        <p>
          What you sent to OpenAI is governed by OpenAI's own retention terms and is not something
          this software can reach in to delete.
        </p>
      </LegalSection>

      <LegalSection title="Questions">
        <p>
          Ask whoever runs your install. If you run it yourself, the code is the answer —{" "}
          <a
            href="https://github.com/covan-ai/covan"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            read it
          </a>
          . Security problems go to the address in <code className="font-mono">SECURITY.md</code>,
          privately, rather than to a public issue.
        </p>
        <p>
          <Link to="/terms" className="text-foreground underline underline-offset-4">
            Terms
          </Link>
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
