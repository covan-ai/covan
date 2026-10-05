import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { assetSrc } from "@/lib/api-client";
import { canConnectToolkit, type ComposioToolkit } from "@/lib/connections-api";
import { useComposioCategories, useComposioToolkits } from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { AppDetailDialog } from "@/components/integrations/app-detail-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * About fifteen hundred applications, arranged so somebody can find one.
 *
 * WHAT THIS REPLACED, because the shape is the whole point. The catalogue used
 * to be a button that opened a text field that ran a search that printed forty
 * rows of plain text — no marks, no headings, no second page, and nothing at
 * all until you had already typed. That is a search box for a person who knows
 * what they want, and it is useless to the far commoner person who wants to
 * know what is on offer. So: the grid is here before anybody types, ordered by
 * how much the catalogue is actually used, filtered by its own headings, and
 * each tile carries the application's own mark because that is what a person
 * scanning for Gmail is looking for.
 *
 * Read `DESIGN.md` before changing any of this. What it constrains here:
 * **no amber**. An active category is the ink chip from `knowledge-explorer`,
 * not the amber square the agent tabs use — a filter row is a place to spend
 * a colour that a page with one accent cannot afford. Marks live inside the
 * 44px neutral tile and never larger. The radius ladder runs 4 chip · 8
 * button · 10 tile · 12 card.
 */

/** How long to wait for somebody to stop typing before asking a third party. */
const DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

export function AppCatalogue({
  /** Slugs already connected here. They are not offered a second time. */
  connected,
}: {
  connected: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  // Debounced, because the query string is the react-query key: without this
  // "hubspot" is seven requests to Composio, six of which are thrown away.
  const search = useDebounced(query.trim(), DEBOUNCE_MS);

  const catalogue = useComposioToolkits(search, category, true);
  const configured = catalogue.data?.pages[0]?.configured !== false;
  const categories = useComposioCategories(configured);

  // The application whose card is open, or null. Held here rather than in the
  // tile so only one can be open, and so the tile stays a button and nothing
  // else.
  const [reading, setReading] = useState<ComposioToolkit | null>(null);

  // Not configured is the `ComposioCard` above's sentence to say, and it says
  // which variable turns this on. A second copy of it here would be the page
  // telling a self-hoster the same thing twice.
  if (!configured) return null;

  const found = (catalogue.data?.pages ?? []).flatMap((page) => page.toolkits);
  // Deduplicated by slug. The pages are a cursor walk over a catalogue of
  // fifteen hundred and nothing promises an application appears on one page
  // only; a repeat would be a duplicate React key, which is a warning in the
  // console and a row that will not update.
  const seen = new Set<string>();
  const toolkits = found.filter(
    (t) => !connected.has(t.slug) && !seen.has(t.slug) && seen.add(t.slug),
  );
  // Which of the two empty states this is. The catalogue answering nothing and
  // the filter above removing everything read identically on screen and are
  // opposite facts — and the second is what somebody sees when they search for
  // the application they just connected.
  const emptyBecauseConnected = toolkits.length === 0 && found.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 1500 applications — gmail, hubspot, linear…"
            aria-label="Search the application catalogue"
            autoComplete="off"
            className="h-10 rounded-md pl-10"
          />
        </div>

        {categories.data?.categories.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryChip active={category === ""} onClick={() => setCategory("")}>
              Popular
            </CategoryChip>
            {categories.data.categories.map((c) => (
              <CategoryChip
                key={c.id}
                active={category === c.id}
                onClick={() => setCategory(category === c.id ? "" : c.id)}
              >
                {c.name}
              </CategoryChip>
            ))}
          </div>
        ) : null}
      </div>

      {catalogue.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : catalogue.isError ? (
        <p className="text-sm text-muted-foreground">
          The catalogue could not be read just now. Try again in a moment.
        </p>
      ) : toolkits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {emptyBecauseConnected
            ? search
              ? `Everything matching “${search}” is already connected — it is in the list above.`
              : "Everything in this part of the catalogue is already connected."
            : search
              ? `Nothing in the catalogue matches “${search}”.`
              : "Nothing in this part of the catalogue."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {toolkits.map((toolkit) => (
            <CatalogueTile
              key={toolkit.slug}
              toolkit={toolkit}
              onOpen={() => setReading(toolkit)}
            />
          ))}
        </ul>
      )}

      <AppDetailDialog toolkit={reading} onClose={() => setReading(null)} />

      {/* Not offered beside an empty grid. "Nothing matches" over a live
          "Show more" is the page contradicting itself in two lines. */}
      {catalogue.hasNextPage && toolkits.length > 0 ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={catalogue.isFetchingNextPage}
            onClick={() => void catalogue.fetchNextPage()}
          >
            {/* No number on it. The page size is the worker's to choose and
                it has changed once already; a button that promises twenty-four
                and delivers forty is a small lie nobody would ever fix. */}
            {catalogue.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        </div>
      ) : null}

      <p className="text-xs leading-[1.5] text-muted-foreground">
        You sign in at the application itself. Covan never sees the password or the token — the
        grant is held by Composio, and what is stored here is a reference to it. An agent asks
        before its first action on each.
      </p>
    </div>
  );
}

/**
 * One application, offered or explained.
 *
 * A row that cannot be connected stays in the list rather than being filtered
 * out, and says why. Hiding it would leave somebody searching for the
 * application they use and concluding Covan has never heard of it, when the
 * truth is that somebody has to register a client with that provider first.
 */
/**
 * One application in the grid.
 *
 * The whole tile is one button, which is right for a 44px tap target and is
 * what it always was. What changed is what pressing it does: it opens the card
 * rather than handing the browser to a consent screen.
 *
 * AN APPLICATION NOBODY CAN CONNECT IS ALSO A BUTTON NOW. It used to be an inert
 * `<div>` at `opacity-60`, which meant nine tenths of the catalogue could not
 * even be read about — and reading about them is the case the card most needs
 * to serve, because "needs setup in Composio" is four truncated words here and
 * a sentence in there. The dimming goes with it: it said "not clickable", and
 * that is now untrue.
 *
 * The focus ring is new and belongs to this change rather than to a tidy-up.
 * There was none anywhere in this folder, which was survivable while the tile
 * was close to decorative; it is not survivable now that the tile is the only
 * way into the card.
 */
function CatalogueTile({ toolkit, onOpen }: { toolkit: ComposioToolkit; onOpen: () => void }) {
  const connectable = canConnectToolkit(toolkit);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border border-hairline bg-background p-3 text-left",
          "transition-colors duration-200 hover:bg-surface-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <AppLogo src={assetSrc(toolkit.logoPath)} name={toolkit.name} />
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate text-sm font-medium leading-tight">{toolkit.name}</span>
          <span className="truncate text-xs leading-tight text-muted-foreground">
            {connectable
              ? toolkit.description || "Connect it and your agents can call it."
              : "Needs setup in Composio"}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The ink filter chip from `knowledge-explorer`. Deliberately not the amber tab. */
function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-sm border px-2 py-1 text-xs transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-hairline text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
