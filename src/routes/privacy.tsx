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
 *
 * The rule cuts both ways and the account paragraph is the proof: it said for
 * months that erasure had no button, which was true when written and became
 * false the day `worker/src/routes/account.ts` shipped. Building a capability
 * puts this page in the change exactly as adding an outbound host does.
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
          <LegalItem>
            <strong className="font-medium text-foreground">Feedback you send</strong> — what you
            typed, which of the three kinds you picked, the path of the page you were on, and, when
            you started from a thumb under a reply, which reply it was. The dialog names both before
            it sends. Readable by whoever runs the install and by nobody in your workspace,
            including an admin — enforced in the database. There is no reply channel: it is a note,
            not a ticket.
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
            dictate. This is the one call the product cannot work without — though where it goes is
            the operator's to change: <code>OPENAI_BASE_URL</code> moves the conversation and{" "}
            <code>EMBEDDING_BASE_URL</code> moves the document text, each to any OpenAI-compatible
            endpoint, and they are set independently. Dictation cannot be moved. Ask whoever runs
            this install which of them are set; nothing on this page can tell you.
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
          Closing your account is in Settings, and it takes your conversations, your API keys, any
          feedback you sent and any workspace you are the last person in with it. A workspace other
          people are still in keeps running: what you made there stays and your name comes off it,
          which is why the one case that is refused is being its last admin — hand the role over
          first.
        </p>
        <p>
          A file you uploaded is part of what stays, and it is worth being exact about why. The
          moment it was indexed it became the workspace's knowledge: other people's answers are
          grounded on it and cite it by name, so removing it on your way out would quietly change
          what their agents know. It is anonymised rather than deleted. If you would rather it were
          deleted, ask before you close the account and not after — a document records who uploaded
          it, and closing the account is what takes that away.
        </p>
        <p>
          There is no separate button for deleting a shared workspace. You can leave one, and an
          admin can remove someone from one, but dismantling a room other people are in is not
          something one person does from this interface.
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
          </Link>{" "}
          ·{" "}
          <Link to="/license" className="text-foreground underline underline-offset-4">
            Licence
          </Link>
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
