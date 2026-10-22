import { Link } from "@tanstack/react-router";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { BrandLockup } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The documents this build carries, as the header's tabs (A34). */
const DOCUMENTS = [
  { to: "/terms", label: "Terms of service" },
  { to: "/privacy", label: "Privacy policy" },
  { to: "/license", label: "Licence" },
] as const;

type LegalPath = (typeof DOCUMENTS)[number]["to"];

/** "What is stored" → "what-is-stored", for a heading's anchor. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The frame for a document somebody has to be able to read before they have
 * an account (A34) — so no app shell, whose sidebar assumes a session.
 *
 * A 56px header with the lockup, the three documents as tabs and Sign in;
 * then "On this page" — every section, from the `LegalSection`s themselves —
 * with when it last changed and whom to ask, beside the article: an eyebrow
 * naming the document, its title, a lede, and the numbered sections.
 */
export function LegalLayout({
  title,
  updated,
  current,
  lede,
  contact = "efe@covan.app",
  children,
}: {
  title: string;
  /** When the text last changed. Written as prose, e.g. "August 2026". */
  updated: string;
  current: LegalPath;
  /** The paragraph under the title, when the document has one. */
  lede?: ReactNode;
  /** Whom questions go to. */
  contact?: string;
  children: ReactNode;
}) {
  const sectionTitles = Children.toArray(children)
    .filter((child) => isValidElement(child) && child.type === LegalSection)
    .map((child) => (child as ReactElement<SectionProps>).props.title);
  const toc = sectionTitles.map((t) => ({ id: slug(t), title: t }));
  const body = Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== LegalSection) return child;
    const { title: sectionTitle } = child.props as SectionProps;
    return cloneElement(child as ReactElement<SectionProps>, {
      id: slug(sectionTitle),
      number: sectionTitles.indexOf(sectionTitle) + 1,
    });
  });
  const active = useActiveSection(toc.map((t) => t.id));
  const doc = DOCUMENTS.find((d) => d.to === current)!;

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-8">
        <Link to="/" aria-label="Covan">
          <BrandLockup />
        </Link>
        <nav aria-label="Legal pages" className="ml-4 hidden h-14 items-stretch gap-1 sm:flex">
          <Link
            to="/terms"
            aria-current={current === "/terms" ? "page" : undefined}
            className={tab(current === "/terms")}
          >
            Terms of service
          </Link>
          <Link
            to="/privacy"
            aria-current={current === "/privacy" ? "page" : undefined}
            className={tab(current === "/privacy")}
          >
            Privacy policy
          </Link>
          <Link
            to="/license"
            aria-current={current === "/license" ? "page" : undefined}
            className={tab(current === "/license")}
          >
            Licence
          </Link>
        </nav>
        <Button variant="secondary" asChild className="ml-auto">
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-[1120px] flex-wrap gap-12 px-4 pt-10 pb-16 sm:px-8">
        <nav
          aria-label="On this page"
          className="w-full lg:sticky lg:top-6 lg:w-[220px] lg:flex-none lg:self-start"
        >
          <div className="px-2.5 pb-2 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
            On this page
          </div>
          <ul className="m-0 list-none p-0">
            {toc.map((t) => (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  aria-current={active === t.id ? "location" : undefined}
                  className={cn(
                    "block rounded-md px-2.5 py-1.5 text-sm",
                    active === t.id
                      ? "bg-sidebar-accent font-medium text-foreground"
                      : "text-nav-foreground hover:bg-sidebar-hover",
                  )}
                >
                  {t.title}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-5 mb-0 border-t border-hairline px-2.5 pt-3 text-meta leading-[1.5] text-muted-foreground">
            Last updated {updated}.
            <br />
            Questions:{" "}
            <a href={`mailto:${contact}`} className="underline underline-offset-4">
              {contact}
            </a>
          </p>
        </nav>

        <article className="min-w-0 max-w-[720px] flex-[1_1_480px]">
          <div className="mb-2.5 text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
            {doc.label}
          </div>
          <h1 className="m-0 mb-2 text-2xl font-semibold">{title}</h1>
          {lede ? (
            <div className="mb-7 text-lead leading-[1.6] text-muted-foreground">{lede}</div>
          ) : null}
          <div className="space-y-12">{body}</div>
        </article>
      </main>
    </div>
  );
}

const tab = (on: boolean) =>
  cn(
    "inline-flex items-center border-b-2 px-2 text-sm",
    on
      ? "border-foreground font-medium text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );

/** The section nearest the top of the window, for "On this page". */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(",");
  useEffect(() => {
    const onScroll = () => {
      let current: string | null = null;
      for (const id of key.split(",")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) current = id;
      }
      setActive(current ?? key.split(",")[0] ?? null);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [key]);
  return active;
}

type SectionProps = { title: string; children: ReactNode; id?: string; number?: number };

/** One numbered section: its heading (anchored, for the contents) and its prose. */
export function LegalSection({ title, children, id, number }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4">
      <h2 className="m-0 text-xl font-semibold">
        {number ? `${number}. ` : ""}
        {title}
      </h2>
      <div className="space-y-3 text-base leading-[1.65] text-foreground">{children}</div>
    </section>
  );
}

/** A list where each row is a destination and what reaches it. */
export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none space-y-2.5 p-0">{children}</ul>;
}

export function LegalItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-[0.65em] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}
