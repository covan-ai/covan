import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { PageContainer, Headline } from "@/components/page-container";

/**
 * The frame for a document somebody has to be able to read before they have an
 * account — so no AppShell, whose sidebar assumes a session and a workspace.
 *
 * `form` width rather than `list`: these are paragraphs, and a measure that
 * suits a table of members is too wide to read prose in.
 */
export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  /** When the text last changed. Written as prose, e.g. "August 2026". */
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-5 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="font-dm text-lg font-semibold leading-none tracking-[-0.02em]">
              Covan
            </span>
          </Link>
          <Link
            to="/sign-in"
            className="text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
      </header>

      <PageContainer width="form">
        <Headline as="h1">{title}</Headline>
        <p className="mt-3 text-sm text-muted-foreground">Last updated {updated}</p>
        <div className="mt-12 space-y-10">{children}</div>
      </PageContainer>
    </div>
  );
}

/** One numbered-feeling block: a DM Sans heading and its prose. */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-dm text-[20px] font-medium leading-tight tracking-[-0.01em]">{title}</h2>
      <div className="space-y-3 text-[15px] leading-[1.55] text-muted-foreground">{children}</div>
    </section>
  );
}

/** A list where each row is a destination and what reaches it. */
export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="space-y-2.5">{children}</ul>;
}

export function LegalItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      {/* Squares, like every other bullet in this system (DESIGN.md §3), and
          ink rather than amber: a list of eight would blow the accent budget
          on decoration, which is the one thing amber is not for. */}
      <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 bg-foreground" />
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}
