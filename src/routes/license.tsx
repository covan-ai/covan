import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalLayout, LegalSection, LegalList, LegalItem } from "@/components/legal-layout";

/**
 * What the licence lets you do, in the build where the licence is the whole
 * agreement.
 *
 * The repository has carried the AGPL's full text since the first commit, and
 * `/terms` has summarised it in three bullets since there was a terms page at
 * all. Neither answers the question somebody actually arrives with, which is
 * not "what does the AGPL say" but "am I allowed to do the specific thing I am
 * about to do" — run a modified copy for my own company, offer it to my
 * customers, call it something else, build it into a product I sell.
 *
 * The hosted repository has a page at this path too and it says more, because
 * it also has to explain what is *not* published. Here there is no such
 * boundary to draw: this tree is the offer. That difference is the reason the
 * two are not the same file, and it is the same reason `/terms` differs — see
 * the header there.
 *
 * The one thing to keep exact: this page must never describe the hosted
 * service's plans, prices or promises. A self-hoster reading it is not a
 * customer, and a sentence about what covan.app includes is a sentence that
 * goes stale here first.
 */
export const Route = createFileRoute("/license")({
  component: LicensePage,
  head: () => ({
    meta: [
      { title: "Licence — Covan" },
      {
        name: "description",
        content:
          "Covan is AGPL-3.0. What you may do with it, the one obligation, the name, and when you need a different licence.",
      },
    ],
  }),
});

const REPO = "https://github.com/covan-ai/covan";

function LicensePage() {
  return (
    <LegalLayout title="Licence" updated="September 2026">
      <p className="text-[15px] leading-[1.55] text-muted-foreground">
        Covan is open source under the{" "}
        <a
          href="https://www.gnu.org/licenses/agpl-3.0.html"
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          GNU Affero General Public License, version 3
        </a>
        . The full text ships in this repository as{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[13px]">LICENSE</code> and
        it is the authority; everything on this page is a summary and loses to it wherever the two
        differ.
      </p>

      <LegalSection title="What you may do">
        <LegalList>
          <LegalItem>
            Run it, read it, change it and host it yourself — including commercially, including
            inside a company, including for as many people as you like — without asking anyone and
            without paying anyone.
          </LegalItem>
          <LegalItem>
            Keep your changes to yourself, as long as you are running it for your own organisation.
            Internal use triggers nothing at all, however heavily modified your copy is.
          </LegalItem>
          <LegalItem>
            Fork it. Every feature is here — there is no separate build, no licence key and nothing
            that checks in with anyone — so a fork is a working product rather than a demo of one.
          </LegalItem>
        </LegalList>
      </LegalSection>

      <LegalSection title="The one obligation">
        <p>
          If you modify Covan and then offer it to other people over a network — a hosted version
          for your customers, a service built on a changed copy — you have to make your changes
          available to those users under the same licence. That is section 13, and it is the only
          condition that distinguishes the AGPL from an ordinary GPL.
        </p>
        <p>
          Running an unmodified copy for your own team does not trigger it. Neither does modifying a
          copy that only your own organisation uses. It is a rule about redistributing a service,
          not a rule about using one.
        </p>
        <p>
          The practical form of it is a link. If you run a modified Covan for other people, give
          those people a way to get the source of the version they are using.
        </p>
      </LegalSection>

      <LegalSection title="The name">
        <p>
          The licence covers the code, not the name. <em>Covan</em>, the wordmark and the logo are
          not granted by the AGPL.
        </p>
        <p>
          What you may always do without asking: say truthfully that your thing is built on Covan,
          is a fork of Covan, or is compatible with it. What you may not do is call it Covan, or use
          the mark in a way that suggests the project runs it or endorses it. If you want to do
          something in between, ask — the answer is usually yes and it is quicker than guessing.
        </p>
      </LegalSection>

      <LegalSection title="When you need a different licence">
        <p>
          The AGPL is the right licence for almost everybody reading this. It stops being the right
          one in a narrow case: you want to build Covan into a proprietary product that you offer to
          other people over a network, and you do not want to publish your changes.
        </p>
        <p>
          A commercial licence exists for that. It is possible because every contribution arrives
          with a grant permitting release under the AGPL or another licence — see{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[13px]">
            CONTRIBUTING.md
          </code>{" "}
          — so the rights are the maintainer's to give. Write to{" "}
          <a
            href="mailto:efe@covan.app"
            className="text-foreground underline underline-offset-4 hover:no-underline"
          >
            efe@covan.app
          </a>{" "}
          and describe what you are building.
        </p>
      </LegalSection>

      <LegalSection title="What you contribute">
        <p>
          A pull request comes with that same grant, which is what keeps a commercial licence
          possible without going back to every contributor. You keep the copyright in what you
          wrote; what you give is permission to release it under this licence or another one.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          The software is provided as is, without warranty of any kind, and the authors are not
          liable for what happens when you run it. That is sections 15 and 16 of the licence and it
          is not a formality: Covan sends your documents to a language model and shows you what
          comes back, and a language model can be confidently wrong. Answers are a starting point,
          not a decision.
        </p>
        <p>
          Running it makes you the operator, which is a role with obligations of its own toward the
          people whose data is in it. What that involves is set out on the{" "}
          <Link to="/privacy" className="text-foreground underline underline-offset-4">
            privacy page
          </Link>{" "}
          and in the security notes that ship with the repository.
        </p>
      </LegalSection>

      <LegalSection title="Other people's code">
        <p>
          Covan depends on a lot of open source, each package under its own licence, and those are
          unaffected by this one. The dependency list is in the repository, so a compliance review
          can be done from{" "}
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            the source
          </a>{" "}
          rather than from a form somebody filled in.
        </p>
        <p>
          <Link to="/terms" className="text-foreground underline underline-offset-4">
            Terms
          </Link>{" "}
          ·{" "}
          <Link to="/privacy" className="text-foreground underline underline-offset-4">
            Privacy
          </Link>
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
