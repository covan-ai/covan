import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from "@tanstack/react-router";

import { LegalAnchor } from "./legal-anchor";

function renderInRouter(ui: ReactNode) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("LegalAnchor", () => {
  it("routes to a built-in page without leaving the app", async () => {
    renderInRouter(<LegalAnchor link={{ href: "/terms", external: false }}>Terms</LegalAnchor>);
    const link = await screen.findByRole("link", { name: "Terms" });
    expect(link).toHaveAttribute("href", "/terms");
    expect(link).not.toHaveAttribute("target");
  });

  it("sends an operator's own document out as a plain anchor", async () => {
    renderInRouter(
      <LegalAnchor link={{ href: "https://example.com/terms", external: true }} newTab>
        Terms
      </LegalAnchor>,
    );
    const link = await screen.findByRole("link", { name: "Terms" });
    expect(link).toHaveAttribute("href", "https://example.com/terms");
    expect(link).toHaveAttribute("target", "_blank");
    // An external document is somebody else's page, and referrers leak which
    // deployment its readers came from.
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("opens in a new tab only when asked, on either kind of link", async () => {
    const { unmount } = renderInRouter(
      <LegalAnchor link={{ href: "/privacy", external: false }} newTab>
        Privacy
      </LegalAnchor>,
    );
    expect(await screen.findByRole("link", { name: "Privacy" })).toHaveAttribute(
      "target",
      "_blank",
    );
    unmount();

    renderInRouter(
      <LegalAnchor link={{ href: "https://example.com/privacy", external: true }}>
        Privacy
      </LegalAnchor>,
    );
    expect(await screen.findByRole("link", { name: "Privacy" })).not.toHaveAttribute("target");
  });

  it("carries no styling of its own when the surrounding surface owns it", async () => {
    // The landing footer styles its links through `.footer__bottom a`; an
    // inline underline class there would be the only underlined thing in the
    // bar.
    renderInRouter(
      <LegalAnchor link={{ href: "/terms", external: false }} variant="plain">
        Terms
      </LegalAnchor>,
    );
    expect(await screen.findByRole("link", { name: "Terms" })).not.toHaveAttribute("class");
  });
});
