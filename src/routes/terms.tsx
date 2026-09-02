import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalLayout, LegalSection, LegalList, LegalItem } from "@/components/legal-layout";

/**
 * The terms that actually apply to this build.
 *
 * Not a service agreement, and not pretending to be one. This repository is
 * software under a licence, and the licence plus its warranty disclaimer is the
 * real legal position of anyone running it — stating that plainly is honest,
 * whereas boilerplate about "the Service" would describe a service this build
 * does not provide.
 *
 * An operator who does run Covan as a service for other people needs their own
 * agreement, written by a lawyer, and points `VITE_TERMS_URL` at it. See
 * `src/lib/legal.ts`.
 */
export const Route = createFileRoute("/terms")({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: "Terms — Covan" },
      { name: "description", content: "The licence Covan is offered under, and what it promises." },
    ],
  }),
});

function TermsPage() {
  return (
    <LegalLayout title="Terms" updated="August 2026">
      <p className="text-[15px] leading-[1.55] text-muted-foreground">
        Covan is open-source software rather than a service, and these are the terms of the
        software. If you are using an install someone else operates — a hosted Covan, or your
        employer's — that operator may have their own agreement with you, and it governs your
        relationship with them.
      </p>

      <LegalSection title="The licence">
        <p>
          Covan is licensed under the{" "}
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-4"
          >
            GNU Affero General Public License, version 3
          </a>
          . In practice:
        </p>
        <LegalList>
          <LegalItem>
            You may run it, read it, change it and self-host it, including commercially and
            including inside your company, without asking anyone.
          </LegalItem>
          <LegalItem>
            If you offer a modified Covan to other people over a network, you must publish your
            changes under the same licence. Running an unmodified copy for your own team triggers
            nothing.
          </LegalItem>
          <LegalItem>
            The full text ships in the repository as{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[13px]">LICENSE</code>,
            and it is the authority — this summary is a convenience and loses to it wherever the two
            differ. The{" "}
            <Link to="/license" className="text-foreground underline underline-offset-4">
              licence page
            </Link>{" "}
            answers the questions the text does not put in one place: the name, contributions, and
            when you would need a different licence.
          </LegalItem>
        </LegalList>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          The software is provided as is, without warranty of any kind, and the authors are not
          liable for what happens when you run it. That is section 15 of the licence and it is not a
          formality: Covan sends your documents to a language model and shows you what comes back,
          and a language model can be confidently wrong. Answers are a starting point, not a
          decision.
        </p>
      </LegalSection>

      <LegalSection title="What you bring">
        <p>
          Your documents and conversations stay yours. Nothing in the licence transfers them to
          anybody, and the software makes no claim on them.
        </p>
        <p>
          You are responsible for having the right to upload what you upload, and for what you point
          a routine at — a scheduled fetch runs under your account, on your schedule, against an
          address you chose.
        </p>
      </LegalSection>

      <LegalSection title="The OpenAI key">
        <p>
          A self-hosted Covan uses an OpenAI API key you supply, and your use of that model is
          between you and OpenAI under their terms. The software does not stand between you and that
          agreement.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          The licence is the licence and does not change. This page can, and the repository's
          history is the record of when it did.
        </p>
        <p>
          <Link to="/privacy" className="text-foreground underline underline-offset-4">
            Privacy
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
