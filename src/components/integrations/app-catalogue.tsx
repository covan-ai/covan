import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { assetSrc } from "@/lib/api-client";
import { canConnectToolkit, type ComposioToolkit } from "@/lib/connections-api";
import {
  useComposioCategories,
  useComposioToolkits,
  useConnectComposio,
} from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
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

  const connect = useConnectComposio();
  const [connecting, setConnecting] = useState("");

  // Not configured is the `ComposioCard` above's sentence to say, and it says
  // which variable turns this on. A second copy of it here would be the page
  // telling a self-hoster the same thing twice.
  if (!configured) return null;

  const toolkits = (catalogue.data?.pages ?? [])
    .flatMap((page) => page.toolkits)
    .filter((t) => !connected.has(t.slug));

  function onConnect(toolkit: ComposioToolkit) {
    setConnecting(toolkit.slug);
    connect.mutate(
      { toolkit: toolkit.slug, label: toolkit.name, noAuth: toolkit.noAuth },
      {
        onError: (err: Error) => {
          setConnecting("");
          toast.error(err.message);
        },
      },
    );
  }

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
          {search
            ? `Nothing in the catalogue matches “${search}”.`
            : "Everything in this part of the catalogue is already connected."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {toolkits.map((toolkit) => (
            <CatalogueTile
              key={toolkit.slug}
              toolkit={toolkit}
              busy={connect.isPending}
              connecting={connecting === toolkit.slug}
              onConnect={() => onConnect(toolkit)}
            />
          ))}
        </ul>
      )}

      {catalogue.hasNextPage ? (
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
function CatalogueTile({
  toolkit,
  busy,
  connecting,
  onConnect,
}: {
  toolkit: ComposioToolkit;
  busy: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const connectable = canConnectToolkit(toolkit);
  const body = (
    <>
      <AppLogo src={assetSrc(toolkit.logoPath)} name={toolkit.name} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate text-sm font-medium leading-tight">{toolkit.name}</span>
        <span className="truncate text-xs leading-tight text-muted-foreground">
          {connecting
            ? "Opening…"
            : connectable
              ? toolkit.description || "Connect it and your agents can call it."
              : "Needs setup in Composio"}
        </span>
      </span>
    </>
  );

  const classes =
    "flex w-full items-center gap-3 rounded-lg border border-hairline bg-background p-3 text-left";

  return (
    <li>
      {connectable ? (
        <button
          type="button"
          disabled={busy}
          onClick={onConnect}
          className={cn(
            classes,
            "transition-colors duration-200 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={cn(classes, "opacity-60")}>{body}</div>
      )}
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
