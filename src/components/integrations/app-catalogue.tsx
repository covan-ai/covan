import { useEffect, useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";

import { Trans, useTranslation } from "@/i18n";
import { assetSrc } from "@/lib/api-client";
import { mightConnectToolkit, type ComposioToolkit } from "@/lib/connections-api";
import { useComposioCategories, useComposioToolkits } from "@/hooks/use-connections";
import { AppLogo } from "@/components/integrations/app-logo";
import { AppDetailDialog } from "@/components/integrations/app-detail-dialog";
import { Chip } from "@/components/chip";
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

export function AppCatalogue({
  connected,
  query,
  leading,
}: {
  /** Slugs already connected here. They are not offered a second time. */
  connected: Set<string>;
  /** The page's search, as typed; debounced here before it reaches Composio. */
  query: string;
  /**
   * The cards that are not Composio's — the sources, Slack, Databases and
   * APIs, the API — first in the grid, filtered by the page.
   */
  leading?: ReactNode;
}) {
  const { t } = useTranslation();
  const [category, setCategory] = useState("");
  const search = useDebounced(query.trim(), DEBOUNCE_MS);

  const catalogue = useComposioToolkits(search, category, true);
  const configured = catalogue.data?.pages[0]?.configured !== false;
  const categories = useComposioCategories(configured);

  const [reading, setReading] = useState<ComposioToolkit | null>(null);

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

  const found = (catalogue.data?.pages ?? []).flatMap((page) => page.toolkits);
  const seen = new Set<string>();
  const toolkits = found.filter(
    (toolkit) => !connected.has(toolkit.slug) && !seen.has(toolkit.slug) && seen.add(toolkit.slug),
  );
  const emptyBecauseConnected = toolkits.length === 0 && found.length > 0;

  return (
    <div className="flex flex-col gap-4">
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
          "Some of these you sign in to; most want a key you get from the application itself, typed on a page at Composio. Either way Covan never sees the password, the token or the key — they are held by Composio, and what is stored here is a reference. An agent asks before its first action on each.",
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
