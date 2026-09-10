import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "../styles.css?url";
import fontsCss from "../fonts.css?url";
import { AgentsProvider } from "../lib/agents-store";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/command-palette";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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
      { property: "og:image", content: "/og.png?v=2" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Covan — the colleague who has read everything" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "/og.png?v=2" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // DM Sans (display) + Geist (interface) are the app's two families, per
      // DESIGN.md §3.2.
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
      // The two files an English page renders from. A @font-face is only found
      // once fontsCss above has parsed, and `font-display: swap` makes that
      // delay visible as a flash of the fallback.
      //
      // Two of six: latin, upright. The latin-ext pair is fetched on demand by
      // unicode-range and the italics are rare enough not to be worth the
      // bandwidth. `crossOrigin` is required even same-origin — fonts are
      // always fetched in CORS mode, and without it the preload lands in a
      // different cache entry than the one @font-face asks for, so the file
      // comes down twice.
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: "/fonts/dm-sans-400-600-latin.woff2",
        crossOrigin: "anonymous",
      },
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

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
        <CommandPalette />
        <Toaster />
      </AgentsProvider>
    </QueryClientProvider>
  );
}
