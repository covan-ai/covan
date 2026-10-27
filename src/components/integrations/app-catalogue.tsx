import { useEffect, useRef, useState, type ReactNode } from "react";
import { Blocks, Search, X } from "lucide-react";

import { Trans, useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import { assetSrc } from "@/lib/api-client";
import { mightConnectToolkit, type ComposioToolkit } from "@/lib/connections-api";
import { useComposioCategories, useComposioToolkits } from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { AppDetailDialog } from "@/components/integrations/app-detail-dialog";
import { Chip } from "@/components/chip";
import { Kbd } from "@/components/kbd";
import { Pills } from "@/components/pills";
import { Button } from "@/components/ui/button";
import { IntegrationCard } from "./integration-row";

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

/**
 * True when a key press belongs to whatever is being typed into, so "/" is a
 * character there and not a shortcut.
 */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function AppCatalogue({
  connected,
  query,
  onQueryChange,
  leading,
}: {
  /** Slugs already connected here. They are not offered a second time. */
  connected: Set<string>;
  /** The page's search, as typed; debounced here before it reaches Composio. */
  query: string;
  /**
   * Given, the catalogue carries its own search field, pinned under the top
   * bar while the grid scrolls past. It is the page's search, not a second
   * one: the page holds the state, so the connected list above narrows too.
   */
  onQueryChange?: (query: string) => void;
  /**
   * The cards that are not Composio's — the sources, Slack, Databases and
   * APIs, the API — first in the grid, filtered by the page.
   */
  leading?: ReactNode;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [category, setCategory] = useState("");
  const typed = query.trim();
  const search = useDebounced(typed, DEBOUNCE_MS);

  const catalogue = useComposioToolkits(search, category, true);
  const configured = catalogue.data?.pages[0]?.configured !== false;
  const categories = useComposioCategories(configured);

  const [reading, setReading] = useState<ComposioToolkit | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const searchable = Boolean(onQueryChange) && configured;

  // "/" from anywhere on the page, the way most catalogues answer it — unless
  // somebody is typing, where it is a character, or a dialog is open over us.
  useEffect(() => {
    if (!searchable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typingInto(e.target) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchable]);

  if (!configured) {
    return (
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {leading}
        <IntegrationCard
          logo={
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface text-chip-foreground">
              <Blocks className="size-3.5" aria-hidden />
            </span>
          }
          name={t("About 1,500 apps")}
          note={<Chip size="sm">{t("Not configured")}</Chip>}
          description={
            <Trans
              t={t}
              i18nKey="Set <code>COMPOSIO_API_KEY</code> to let agents search Gmail, HubSpot, Linear and the rest, and call the ones you connect."
              components={{ code: <span className="font-mono text-xs" /> }}
            />
          }
        />
      </ul>
    );
  }

  // The server's answer for what is typed now has not arrived: either the
  // debounce is still running, or the request is out and the grid is showing
  // the previous answer in its place.
  const settling = typed !== search || catalogue.isPlaceholderData;
  const needle = typed.toLocaleLowerCase(locale);
  // Meanwhile the tiles already here are narrowed on every keystroke, so the
  // grid answers at typing speed and the server only adds what it alone knows.
  const narrowed = (toolkit: ComposioToolkit) =>
    !settling ||
    !needle ||
    [toolkit.name, toolkit.slug, toolkit.description].some((text) =>
      text?.toLocaleLowerCase(locale).includes(needle),
    );

  const found = (catalogue.data?.pages ?? []).flatMap((page) => page.toolkits).filter(narrowed);
  const seen = new Set<string>();
  const toolkits = found.filter(
    (toolkit) => !connected.has(toolkit.slug) && !seen.has(toolkit.slug) && seen.add(toolkit.slug),
  );
  const emptyBecauseConnected = toolkits.length === 0 && found.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {searchable ? (
        // Pinned under the top bar (56px on a phone, 48 from lg) for as long
        // as the catalogue is on screen: the page's header search is a long
        // way up by the time anybody is scrolling tiles.
        <div className="sticky top-14 z-10 -my-2 bg-background py-2 lg:top-12">
          <div className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-card px-2.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={field}
              type="search"
              aria-label={t("Search the catalogue")}
              placeholder={t("Search about 1,500 apps…")}
              value={query}
              onChange={(e) => onQueryChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                if (query) onQueryChange?.("");
                else e.currentTarget.blur();
              }}
              className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {typed && settling ? (
              <span role="status" className="shrink-0 text-meta text-muted-foreground">
                {t("Searching…")}
              </span>
            ) : typed ? (
              <span className="shrink-0 text-meta text-muted-foreground">
                {catalogue.hasNextPage
                  ? t("{{total}}+ found", { total: toolkits.length })
                  : t("{{total}} found", { total: toolkits.length })}
              </span>
            ) : (
              <Kbd className="hidden shrink-0 lg:inline-flex">/</Kbd>
            )}
            {query ? (
              <button
                type="button"
                aria-label={t("Clear the search")}
                onClick={() => {
                  onQueryChange?.("");
                  field.current?.focus();
                }}
                className="-mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-surface hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {categories.data?.categories.length ? (
        <Pills
          label={t("Categories")}
          value={category}
          onChange={(v) => setCategory(v === category ? "" : v)}
          options={[
            { value: "", label: t("All") },
            ...categories.data.categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      ) : null}

      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {category === "" ? leading : null}
        {toolkits.map((toolkit) => (
          <CatalogueTile key={toolkit.slug} toolkit={toolkit} onOpen={() => setReading(toolkit)} />
        ))}
      </ul>

      {catalogue.isPending ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : catalogue.isError ? (
        <p className="text-sm text-muted-foreground">
          {t("The catalogue could not be read just now. Try again in a moment.")}
        </p>
      ) : toolkits.length === 0 && settling ? (
        // An empty narrowing is not an answer yet: the server may know an
        // application whose name the loaded tiles do not contain.
        <p className="text-sm text-muted-foreground">{t("Searching…")}</p>
      ) : toolkits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {emptyBecauseConnected
            ? search
              ? t(
                  "Everything matching “{{query}}” is already connected — it is in the list above.",
                  { query: search },
                )
              : t("Everything in this part of the catalogue is already connected.")
            : search
              ? t("Nothing in the catalogue matches “{{query}}”.", { query: search })
              : t("Nothing in this part of the catalogue.")}
        </p>
      ) : null}

      <AppDetailDialog toolkit={reading} onClose={() => setReading(null)} />

      {/* Not offered beside an empty grid. "Nothing matches" over a live
          "Show more" is the page contradicting itself in two lines. */}
      {catalogue.hasNextPage && toolkits.length > 0 ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={catalogue.isFetchingNextPage}
            onClick={() => void catalogue.fetchNextPage()}
          >
            {catalogue.isFetchingNextPage ? t("Loading…") : t("Show more")}
          </Button>
        </div>
      ) : null}

      <p className="m-0 text-meta leading-[1.5] text-muted-foreground">
        {t(
          "Some of these you sign in to; most want a key you get from the application itself, typed on a page at Composio. Either way Covan never sees the password, the token or the key — they are held by Composio, and what is stored here is a reference. Agents read what you connect without asking, and ask before changing anything unless you tell them not to.",
        )}
      </p>
    </div>
  );
}

/**
 * One application in the grid (A8): its mark, name and one line, and a
 * button that opens its card — never the consent screen directly. An
 * application nobody can connect yet is still here and still opens, so it can
 * be read about; it says so instead of offering Connect.
 */
function CatalogueTile({ toolkit, onOpen }: { toolkit: ComposioToolkit; onOpen: () => void }) {
  const { t } = useTranslation();
  const connectable = mightConnectToolkit(toolkit);

  return (
    <IntegrationCard
      logo={<AppLogo src={assetSrc(toolkit.logoPath)} name={toolkit.name} size={28} />}
      name={toolkit.name}
      description={
        <span className="line-clamp-2">
          {connectable
            ? toolkit.description || t("Connect it and your agents can call it.")
            : t("Not available yet")}
        </span>
      }
      action={
        <Button
          size="sm"
          variant={connectable ? "secondary" : "ghost"}
          aria-haspopup="dialog"
          aria-label={
            connectable
              ? t("Connect {{app}}", { app: toolkit.name })
              : t("About {{app}}", { app: toolkit.name })
          }
          onClick={onOpen}
        >
          {connectable ? t("Connect") : t("About")}
        </Button>
      }
    />
  );
}
