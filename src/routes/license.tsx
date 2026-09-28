import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalLayout, LegalSection, LegalList, LegalItem } from "@/components/legal-layout";

/**
 * What the licence lets you do, in the build where the licence is the whole
 * agreement.
 *
 * The repository carries the licence's full text, and `/terms` summarises it in
 * three bullets. Neither answers the question somebody actually arrives with,
 * which is not "what does the FSL say" but "am I allowed to do the specific
 * thing I am about to do" — run a modified copy for my own company, offer it to
 * my customers, call it something else, build it into a product I sell.
 *
 * Covan was AGPL-3.0 until v0.2.0 and is FSL-1.1-ALv2 from v0.3.0. The one
 * thing that changed for a reader of this page: reselling Covan as hosting used
 * to be permitted and is now the single thing that is not. Everything a
 * self-hoster does is unchanged, which is why the "what you may do" list below
 * is longer than the restriction.
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
          "Covan is FSL-1.1-ALv2. What you may do with it, the one restriction, the name, when it becomes Apache 2.0, and when you need a different licence.",
      },
    ],
  }),
});

const REPO = "https://github.com/covan-ai/covan";

function LicensePage() {
  return (
    <LegalLayout title="Licence" updated="September 2026">
      <p className="text-base text-muted-foreground">
        Covan is licensed under the{" "}
        <a
          href="https://fsl.software"
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          Functional Source License, version 1.1
        </a>
        , with Apache 2.0 as the future licence —{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-meta">FSL-1.1-ALv2</code>.
        The full text ships in this repository as{" "}
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-meta">LICENSE</code> and it
        is the authority; everything on this page is a summary and loses to it wherever the two
        differ.
      </p>

      <LegalSection title="What you may do">
        <LegalList>
          <LegalItem>
            Run it, read it, change it and host it for your own team — including commercially,
            including inside a company, including for as many people as you like — without asking
            anyone and without paying anyone. Internal use is named in the licence as a permitted
            purpose, so this is a grant rather than an omission.
          </LegalItem>
          <LegalItem>
            Keep your changes to yourself, however heavily modified your copy is. There is no
            obligation to publish anything, ever.
          </LegalItem>
          <LegalItem>
            Fork it. Every feature is here — there is no separate build, no licence key and nothing
            that checks in with anyone — so a fork is a working product rather than a demo of one.
          </LegalItem>
          <LegalItem>
            Charge for professional services around Covan: install it, run it, customise it or
            support it for somebody who is themselves a Covan licensee. The licence names that too.
          </LegalItem>
        </LegalList>
      </LegalSection>

      <LegalSection title="The one restriction">
        <p>
          You may not make Covan available to others in a commercial product or service that
          substitutes for Covan — reselling it as hosting, in other words, or shipping it inside
          something you sell that does the same job. The licence calls this a Competing Use, and it
          is the only thing the licence forbids.
        </p>
        <p>
          Running it for your own organisation is not a Competing Use, no matter how large the
          organisation or how much you modified the code. Neither is doing paid work on somebody
          else's Covan. The line is whether you are offering Covan itself to other people as the
          product.
        </p>
        <p>
          This is the one place Covan's licence differs from an open-source one, and it is the
          reason the licence changed. Under the AGPL, reselling Covan as hosting was permitted
          outright — hosting an unmodified copy carried no obligation at all.
        </p>
      </LegalSection>

      <LegalSection title="It becomes Apache 2.0">
        <p>
          Two years after each version is published, that version is additionally available to you
          under the Apache License 2.0 — fully permissive, restriction gone. The licence grants this
          irrevocably and in advance, so it does not depend on anyone's goodwill, continued
          existence or change of mind.
        </p>
        <p>
          It is there for the question a small project deserves to be asked: what happens to the
          code if the people behind it stop. The answer is that every version you are running is
          already on a two-year clock to Apache 2.0, and nothing can stop that clock.
        </p>
      </LegalSection>

      <LegalSection title="Is this open source?">
        <p>
          No, and it would be wrong to say otherwise. The Open Source Initiative has not approved
          the FSL and does not consider a licence with a competing-use restriction to be open
          source. Covan is <em>source-available</em>: the whole product is published, readable,
          modifiable and free to run, and one commercial use of it is reserved.
        </p>
        <p>
          Versions up to v0.2.0 were released under AGPL-3.0, and that grant is irrevocable — those
          versions stay AGPL-3.0 forever, for anyone who has them. The change applies from v0.3.0
          onward.
        </p>
      </LegalSection>

      <LegalSection title="The name">
        <p>
          The licence covers the code, not the name. <em>Covan</em>, the wordmark and the logo are
          not granted by it — the licence says so explicitly, in its Trademarks clause.
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
          The FSL is the right licence for almost everybody reading this. It stops being the right
          one in one case: you want to offer Covan to other people as a paid hosted or managed
          service, or build it into a commercial product that does what Covan does.
        </p>
        <p>
          A commercial licence exists for that, and it is a normal thing to buy rather than an
          awkward exception. It is possible because every contribution arrives with a grant
          permitting release under another licence — see{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-meta">
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
          wrote, and the grant comes back to you non-exclusively, so you may keep using your own
          contribution anywhere for anything.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          The software is provided as is, without warranty of any kind, and the authors are not
          liable for what happens when you run it. That is the licence's Disclaimer and it is not a
          formality: Covan sends your documents to a language model and shows you what comes back,
          and a language model can be confidently wrong. Answers are a starting point, not a
          decision.
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
