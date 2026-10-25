import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { connect, navigateAway } = vi.hoisted(() => ({
  connect: vi.fn(),
  navigateAway: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ api: { composio: { connect } } }));
vi.mock("@/lib/safe-url", () => ({ navigateAway }));

const { useConnectComposio } = await import("./use-connections");

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useConnectComposio", () => {
  // The welcome flow connects a mailbox mid-step and has to come back to it.
  it("asks to come back to the page it was started from", async () => {
    connect.mockResolvedValue({ url: "https://consent.composio.dev/x", connection: { id: "c1" } });
    const client = new QueryClient();
    const { result } = renderHook(() => useConnectComposio(), { wrapper: wrapperFor(client) });

    result.current.mutate({ toolkit: "gmail", returnTo: "/welcome?step=connect&agent=a1&s=s1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(connect).toHaveBeenCalledWith({
      toolkit: "gmail",
      returnTo: "/welcome?step=connect&agent=a1&s=s1",
    });
    expect(navigateAway).toHaveBeenCalledWith("https://consent.composio.dev/x");
  });
});
