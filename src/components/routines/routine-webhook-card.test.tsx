import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutineWebhookCard } from "./routine-webhook-card";

const { trigger, createTrigger, removeTrigger } = vi.hoisted(() => ({
  trigger: vi.fn(),
  createTrigger: vi.fn(),
  removeTrigger: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { routines: { trigger, createTrigger, removeTrigger } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoutineWebhookCard routineId="r1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  [trigger, createTrigger, removeTrigger, toastError, toastSuccess].forEach((m) => m.mockReset());
});

describe("RoutineWebhookCard", () => {
  it("offers to make one when there is none", async () => {
    trigger.mockResolvedValue({ configured: false });

    renderCard();

    expect(await screen.findByText(/No webhook URL yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Make a webhook URL/i })).toBeInTheDocument();
  });

  // The server keeps a SHA-256 and cannot show it again. If this screen closes
  // over the URL, the only way forward is replacing it.
  it("shows the full URL once, and says it will not be shown again", async () => {
    const user = userEvent.setup();
    trigger.mockResolvedValue({ configured: false });
    createTrigger.mockResolvedValue({ token: "covan_whk_x", path: "/routine-hooks/covan_whk_x" });

    renderCard();
    await user.click(await screen.findByRole("button", { name: /Make a webhook URL/i }));

    // VITE_API_URL is undefined under vitest, so only the path is asserted —
    // what matters is that the token is joined to the API base rather than
    // shown bare.
    expect(await screen.findByText(/\/routine-hooks\/covan_whk_x$/)).toBeInTheDocument();
    expect(screen.getByText(/only time it is shown/i)).toBeInTheDocument();
  });

  // It spends the owner's allowance on every call, which is a thing somebody
  // pasting it into a public CI config should be told once, here.
  it("says what holding the URL lets somebody do", async () => {
    const user = userEvent.setup();
    trigger.mockResolvedValue({ configured: false });
    createTrigger.mockResolvedValue({ token: "covan_whk_x", path: "/routine-hooks/covan_whk_x" });

    renderCard();
    await user.click(await screen.findByRole("button", { name: /Make a webhook URL/i }));

    expect(await screen.findByText(/spends your allowance/i)).toBeInTheDocument();
  });

  it("reports an existing one without showing it", async () => {
    trigger.mockResolvedValue({ configured: true, createdAt: 0, lastUsedAt: null });

    renderCard();

    expect(await screen.findByText(/has a webhook URL/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has used it yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/routine-hooks/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replace the URL/i })).toBeInTheDocument();
  });

  it("says when it last fired", async () => {
    trigger.mockResolvedValue({
      configured: true,
      createdAt: 0,
      lastUsedAt: Date.parse("2026-09-20T09:00:00Z"),
    });

    renderCard();

    expect(await screen.findByText(/Last used/i)).toBeInTheDocument();
  });

  // Replacing invalidates the old URL immediately, so the confirmation has to
  // say that rather than ask a vague "are you sure".
  it("warns that replacing breaks whatever is calling the old URL", async () => {
    const user = userEvent.setup();
    trigger.mockResolvedValue({ configured: true, createdAt: 0, lastUsedAt: null });

    renderCard();
    await user.click(await screen.findByRole("button", { name: /Replace the URL/i }));

    expect(await screen.findByText(/stops working the moment you confirm/i)).toBeInTheDocument();
  });

  it("turns it off and says so", async () => {
    const user = userEvent.setup();
    trigger.mockResolvedValue({ configured: true, createdAt: 0, lastUsedAt: null });
    removeTrigger.mockResolvedValue(undefined);

    renderCard();
    await user.click(await screen.findByRole("button", { name: /Turn it off/i }));
    await user.click(await screen.findByRole("button", { name: /^Turn off$/i }));

    expect(removeTrigger).toHaveBeenCalledWith("r1");
    expect(toastSuccess).toHaveBeenCalledWith("Webhook turned off");
  });

  it("reports the API's own message when minting fails", async () => {
    const user = userEvent.setup();
    trigger.mockResolvedValue({ configured: false });
    const { ApiError } = await import("@/lib/api-client");
    createTrigger.mockRejectedValue(
      new ApiError(400, "this routine is not set to accept webhook triggers"),
    );

    renderCard();
    await user.click(await screen.findByRole("button", { name: /Make a webhook URL/i }));

    expect(toastError).toHaveBeenCalledWith("this routine is not set to accept webhook triggers");
  });
});
