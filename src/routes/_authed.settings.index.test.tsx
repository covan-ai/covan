import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (options: unknown) => ({ redirect: options }),
}));

const { Route } = await import("./_authed.settings.index");

describe("/settings", () => {
  it("opens on General, replacing the entry so Back does not bounce", () => {
    expect.assertions(1);
    const route = Route as unknown as { beforeLoad: () => void };
    try {
      route.beforeLoad();
    } catch (thrown) {
      expect(thrown).toEqual({ redirect: { to: "/settings/general", replace: true } });
    }
  });
});
