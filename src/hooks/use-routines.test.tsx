import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCreateRoutine, routinesKey, channelsKey } from "./use-routines";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  api: { routines: { create } },
}));

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useCreateRoutine", () => {
  /**
   * Fix-round finding 1: a create sent with `deliveryEmail` instead of
   * `deliveryChannelId` writes a new delivery_channels row on the way in (see
   * worker/src/routes/routines.ts's inline channel creation), so a stale
   * channel list is just as wrong as a stale routine list. `CreateRoutineDialog`
   * stays mounted across creates — it lives in the page header — so without
   * this, `useDeliveryChannels` never learns the workspace now has a channel,
   * and every routine made from a template after the first writes another one.
   */
  it("invalidates both the routine list and the channel list on success", async () => {
    create.mockResolvedValue({ id: "r1" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useCreateRoutine(), { wrapper: wrapperFor(client) });
    result.current.mutate({
      agentId: "a1",
      name: "First week",
      sourceKind: "none",
      instruction: "say something",
      deliveryEmail: "me@example.com",
      scheduleCron: "0 9 * * *",
      timezone: "UTC",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: routinesKey });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: channelsKey });
  });
});
