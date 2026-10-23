import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ErrorPage } from "@/components/error-page";
import { errorIdOf } from "@/lib/error-id";

import appCss from "../styles.css?url";
import fontsCss from "../fonts.css?url";
import { AgentsProvider } from "../lib/agents-store";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { Toaster } from "@/components/ui/sonner";
import { takeSensitiveParams } from "../lib/sensitive-url";
import { requestLocale } from "@/i18n/request-locale";
import { LocaleProvider, useHtmlLang } from "@/i18n/provider";

// Before the router renders and before the first page view is sent: a connect
// flow's grant comes back in the address bar, and it is taken out of it here.
// See `lib/sensitive-url.ts`.
takeSensitiveParams();

function NotFoundComponent() {
  return <ErrorPage kind="not-found" standalone />;
}

/*
 * `ErrorComponentProps` rather than a hand-written `{ error: Error }`: what
 * reaches an error boundary is whatever was thrown. The root's is the page
 * on its own (A31), before there is a shell to keep.
 */
function ErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [errorId] = useState(() => {
    const id = errorIdOf(error);
    console.error(id, error);
    return id;
  });
  return (
    <ErrorPage
      kind="error"
      standalone
      errorId={errorId}
      onRetry={() => {
        void router.invalidate();
        reset();
      }}
    />
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // The language the page is served in, decided once per request from the
  // cookie and the browser (`i18n/request-locale.ts`). Returned from
  // `beforeLoad` so it is dehydrated into the page and the client's first
  // render is the server's — the same reason the theme is read before
  // hydration below.
  beforeLoad: () => ({ locale: requestLocale() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Covan — The colleague who has read everything" },
      {
        name: "description",
        content:
          "One agent that has read everything your team wrote down, and a private chat with it for every person. Every answer names its source.",
      },
      { name: "author", content: "Covan" },
      { property: "og:title", content: "Covan — The colleague who has read everything" },
      {
        property: "og:description",
        content:
          "One agent that has read everything your team wrote down, and a private chat with it for every person.",
      },
      { property: "og:type", content: "website" },
      // Relative on purpose. An absolute URL would have to name one deployment,
      // and every self-hoster serves this from their own domain. Slack, Discord,
      // X and LinkedIn all resolve a relative og:image against the page URL.
      // The `?v=` is the same trick the favicons use below, and for the same
      // reason: Slack, X and LinkedIn cache a scraped card by URL and will keep
      // serving the old artwork long after the file changes. Bump it whenever
      // og.png is redrawn.
      { property: "og:image", content: "/og.png?v=3" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Covan — the colleague who has read everything" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "/og.png?v=3" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // Geist is the app's one family, per DESIGN.md §3.
      //
      // Vendored into public/fonts rather than linked from Google's CDN. Two
      // reasons, and for a self-hosted install the second one decides it: the
      // link cost two connections in front of first paint that a preconnect
      // could shorten but not remove, and it told a third party the address of
      // everyone who opened a page of *your* deployment. On a machine with no
      // route out it did not degrade gracefully either — the request failed and
      // the whole interface fell back to a system face.
      //
      // Regenerate with `node scripts/fetch-fonts.mjs`.
      { rel: "stylesheet", href: fontsCss },
      // The file an English page renders from. A @font-face is only found
      // once fontsCss above has parsed, and `font-display: swap` makes that
      // delay visible as a flash of the fallback.
      //
      // One of two: latin. The latin-ext file is fetched on demand by
      // unicode-range. `crossOrigin` is required even same-origin — fonts are
      // always fetched in CORS mode, and without it the preload lands in a
      // different cache entry than the one @font-face asks for, so the file
      // comes down twice.
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: "/fonts/geist-400-600-latin.woff2",
        crossOrigin: "anonymous",
      },
      // The `?v=` is not decoration. Browsers cache a favicon far more
      // stubbornly than any other asset — often past a hard reload, and past
      // whatever the host sends for `Cache-Control` — so a redrawn icon can
      // keep showing the old one for weeks. Changing the URL is the only
      // reliable way to retire it. Bump this whenever the icons change.
      { rel: "icon", href: "/favicon.ico?v=3", type: "image/x-icon" },
      { rel: "icon", href: "/favicon-32.png?v=3", type: "image/png", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png?v=3" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

/*
 * The shell renders outside the matched routes, so the language cannot
 * come from a provider the page renders: it is read straight from the root
 * route's context here, and the provider goes around `<html>` itself —
 * which puts the document's own `lang` inside it too.
 */
function RootShell({ children }: { children: ReactNode }) {
  const locale = Route.useRouteContext({ select: (c) => c.locale });
  return (
    <LocaleProvider locale={locale}>
      <Document>{children}</Document>
    </LocaleProvider>
  );
}

function Document({ children }: { children: ReactNode }) {
  const lang = useHtmlLang();
  return (
    <html lang={lang}>
      <head>
        {/* Runs before hydration to set the theme class and avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AgentsProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        <Toaster />
      </AgentsProvider>
    </QueryClientProvider>
  );
}
