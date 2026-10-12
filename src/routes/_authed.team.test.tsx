import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (options: unknown) => ({ redirect: options }),
}));

const { Route } = await import("./_authed.team");

describe("/team", () => {
  // Old bookmarks and every joined-the-workspace email ever sent link here.
  it("sends you to the members page", () => {
    expect.assertions(1);
    const route = Route as unknown as { beforeLoad: () => void };
    try {
      route.beforeLoad();
    } catch (thrown) {
      expect(thrown).toEqual({ redirect: { to: "/settings/members", replace: true } });
    }
  });
});
