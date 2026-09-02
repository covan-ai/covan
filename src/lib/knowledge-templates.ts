/**
 * Six documents to start from, for the account that has nothing to upload yet.
 *
 * The Knowledge tab used to answer "what should I put in here?" with a list of
 * file extensions. That is the answer to a different question. Somebody
 * evaluating Covan for a team that has not written anything down — which is most
 * early teams, and exactly the ones an agent that reads what you wrote down is
 * for — reads `md, txt, csv, json, pdf` and learns nothing about what a good
 * document *is*. It was reported in those words: the format was not clear even
 * after reading the docs page, and what was wanted was a form to fill in.
 *
 * So these are forms to fill in. Each is a heading structure with a bracketed
 * prompt under it, and the prompts are questions rather than instructions,
 * because a question is a thing you can answer in one sitting.
 *
 * Three decisions worth not re-deriving:
 *
 * **They download rather than upload.** An empty template inside a bundle is
 * worse than no document: retrieval would match it, the agent would ground an
 * answer in `[Two or three sentences]`, and the source chip under that answer
 * would say the file was read. A skeleton has to be filled in somewhere the
 * agent cannot see it.
 *
 * **Each file is one subject.** A bundle is the unit of what an agent can see
 * (docs/knowledge.md), and a chunk is what a question actually matches. One
 * enormous "company handbook" retrieves worse than six files, because the
 * passage that answers a pricing question sits in a document about everything.
 *
 * **The prompts ask for prose, not for bullets of nouns.** Retrieval is
 * similarity between the question's meaning and the passage's, so a line that
 * reads "Pricing: TBD" matches almost nothing anybody would actually ask.
 */

export type KnowledgeTemplate = {
  /** Stable, and used as the download's filename. */
  filename: string;
  title: string;
  /** One line, shown next to the title. Says what the file is for, not what is in it. */
  blurb: string;
  body: string;
};

export const KNOWLEDGE_TEMPLATES: KnowledgeTemplate[] = [
  {
    filename: "company-overview.md",
    title: "Company overview",
    blurb: "What you do and who for — the file every other answer leans on.",
    body: `# Company overview

## What we do
[Two or three sentences a new hire would understand. What the product is, in
plain words, without the pitch.]

## Who it is for
[Which kind of company, which role inside it, and what they were doing before
they found you.]

## The problem we solve
[What goes wrong for that person without us, described the way they would
describe it rather than the way we would.]

## How we are different from the alternatives
[Name the alternatives, including "a spreadsheet" and "nothing". For each one,
the one thing we do that it does not.]

## What we deliberately do not do
[The requests we turn down, and why. This is the section that stops an agent
inventing a feature we do not have.]

## Where we are today
[Stage, team size, how many customers, what is next. Put a date on it.]
`,
  },
  {
    filename: "product-notes.md",
    title: "Product notes",
    blurb: "What it does, what it cannot do yet, and the limits people hit.",
    body: `# Product notes

## What the product does
[The main jobs it performs, one short paragraph each. Order them by how often
somebody uses them, not by how hard they were to build.]

## How somebody gets started
[The first five minutes, step by step, as if writing to a customer.]

## Limits and known gaps
[Sizes, counts, formats, anything that fails. Be specific: "files up to 10 MB"
beats "large files may not work". An agent that knows the limits stops
promising things.]

## Things people commonly get wrong
[The misunderstandings that come up in support, and the correct version of
each.]

## What is coming, and what is not
[Only what has been decided. A roadmap the agent reads becomes a promise
somebody quotes back.]
`,
  },
  {
    filename: "faq.md",
    title: "FAQ",
    blurb: "Real questions with real answers — the highest-value file to upload first.",
    body: `# FAQ

[Write the questions in the words people actually use, including the clumsy
ones. Retrieval matches a question against these, so a heading phrased the way
a customer types it is worth more than a tidy one.]

## [How much does it cost?]
[The answer, in full. If the answer is "it depends", say what it depends on.]

## [Can I use it with <the tool everyone asks about>?]
[The answer.]

## [What happens to my data?]
[The answer.]

## [How do I get support, and how fast do you reply?]
[The answer.]

## [Question we get every week that is not on this list]
[The answer.]
`,
  },
  {
    filename: "how-we-work.md",
    title: "How we work",
    blurb: "Process, ownership and tools — what a new teammate asks in week one.",
    body: `# How we work

## Who owns what
[Name each area and the person accountable for it. Roles, not org chart.]

## The tools we use, and for what
[One line each: where code lives, where decisions are written, where customers
reach us, where money is tracked.]

## How work gets picked up
[From idea to shipped: who decides, what has to be true before it starts, what
has to be true before it is called done.]

## Our regular meetings
[When, who is in them, what each one is for, and what it is not for.]

## Decisions we have already made
[The arguments we do not want to have again, with the reasoning. This is the
section that pays for itself.]
`,
  },
  {
    filename: "glossary.md",
    title: "Glossary",
    blurb: "Your internal words, so the agent answers in your vocabulary.",
    body: `# Glossary

[Every team invents words. An agent that does not know them answers questions
about something else entirely — and this is the cheapest file here to write.]

## [Term]
[What it means here specifically, not what it means in general. Note it if the
wider industry uses the word differently.]

## [Acronym]
[What it stands for, and when somebody would say it.]

## [A word we use for a thing customers call something else]
[Both words, and which one to use when writing to a customer.]
`,
  },
  {
    filename: "meeting-notes.md",
    title: "Meeting notes",
    blurb: "A shape to reuse — the notes a team already takes, made retrievable.",
    body: `# [Meeting name] — [YYYY-MM-DD]

**Present:** [names]

## What we talked about
[A paragraph per topic. Enough context that this reads correctly in six months
to somebody who was not there.]

## What we decided
[One line per decision, with the reason. A decision without its reason gets
reopened.]

## What we did not decide
[Open questions, and who is finding out.]

## Next steps
- [ ] [Who] — [what] — [by when]
`,
  },
];
