import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryChannelsCard } from "./delivery-channels-card";

const { list, remove } = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  api: { deliveryChannels: { list, remove, create: vi.fn() } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeliveryChannelsCard />
    </QueryClientProvider>,
  );
}

describe("DeliveryChannelsCard", () => {
  beforeEach(() => {
    list.mockReset();
    remove.mockReset();
  });

  it("shows each channel by its masked label", async () => {
    list.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@gmail.com", createdAt: 0 },
      { id: "c2", kind: "slack_webhook", label: "hooks.slack.com/…a3f9", createdAt: 0 },
    ]);

    renderCard();

    expect(await screen.findByText("m…a@gmail.com")).toBeInTheDocument();
    expect(screen.getByText("hooks.slack.com/…a3f9")).toBeInTheDocument();
  });

  it("explains the empty state instead of showing a bare list", async () => {
    list.mockResolvedValue([]);

    renderCard();

    expect(await screen.findByText(/No delivery channels yet/i)).toBeInTheDocument();
  });
});
