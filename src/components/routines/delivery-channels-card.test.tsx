import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryChannelsCard } from "./delivery-channels-card";

const { list, remove, create, test, rotate } = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  test: vi.fn(),
  rotate: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { deliveryChannels: { list, remove, create, test, rotate } },
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
      <DeliveryChannelsCard />
    </QueryClientProvider>,
  );
}

const WEBHOOK = {
  id: "c3",
  kind: "webhook" as const,
  label: "deploy.acme.example/…7f2c",
  createdAt: 0,
};

describe("DeliveryChannelsCard", () => {
  beforeEach(() => {
    [list, remove, create, test, rotate, toastError, toastSuccess].forEach((m) => m.mockReset());
  });

  it("shows each channel by its masked label", async () => {
    list.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@gmail.com", createdAt: 0 },
      { id: "c2", kind: "slack_webhook", label: "hooks.slack.com/…a3f9", createdAt: 0 },
      WEBHOOK,
    ]);

    renderCard();

    expect(await screen.findByText("m…a@gmail.com")).toBeInTheDocument();
    expect(screen.getByText("hooks.slack.com/…a3f9")).toBeInTheDocument();
    expect(screen.getByText("deploy.acme.example/…7f2c")).toBeInTheDocument();
  });

  it("explains the empty state instead of showing a bare list", async () => {
    list.mockResolvedValue([]);

    renderCard();

    expect(await screen.findByText(/No delivery channels yet/i)).toBeInTheDocument();
  });

  // DESIGN.md's fifth failure mode. The delete button was reachable only by
  // hovering, which is no route at all on a phone and none from a keyboard —
  // and two more actions have just been added next to it.
  it("keeps its row actions reachable without a pointer", async () => {
    list.mockResolvedValue([WEBHOOK]);
    renderCard();

    const remove = await screen.findByRole("button", { name: /^Remove/ });
    const sendTest = screen.getByRole("button", { name: /^Send a test/ });

    for (const button of [remove, sendTest]) {
      // Shown outright where there is no hover, revealed by focus where there is.
      expect(button.className).toContain("focus-visible:opacity-100");
      expect(button.className).toContain("sm:opacity-0");
    }
  });

  it("offers a rotate only for the kind that has a signature", async () => {
    list.mockResolvedValue([
      { id: "c1", kind: "email", label: "m…a@gmail.com", createdAt: 0 },
      WEBHOOK,
    ]);

    renderCard();
    await screen.findByText("m…a@gmail.com");

    const rotates = screen.getAllByRole("button", { name: /Rotate the signing secret/ });
    expect(rotates).toHaveLength(1);
    expect(rotates[0]).toHaveAccessibleName(/deploy\.acme\.example/);
  });

  // The server stores the secret encrypted because signing needs it back, but
  // it is never read out to a client a second time. If this screen closes over
  // it, the only way forward is a rotation.
  it("shows a new webhook's signing secret once, and says so", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([]);
    create.mockResolvedValue({ ...WEBHOOK, signingSecret: "whsec_TESTSECRET" });

    renderCard();
    await screen.findByText(/No delivery channels yet/i);

    await user.click(screen.getByRole("button", { name: /Add channel/i }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Webhook" }));
    await user.type(screen.getByLabelText(/Webhook URL/i), "https://deploy.acme.example/covan");
    await user.click(screen.getByRole("button", { name: /^Add channel$/ }));

    expect(await screen.findByText("whsec_TESTSECRET")).toBeInTheDocument();
    expect(screen.getByText(/only time it is shown/i)).toBeInTheDocument();
    // Still open: closing here would lose the one copy that exists.
    expect(screen.getByRole("button", { name: /I've saved it/i })).toBeInTheDocument();
  });

  it("closes without a reveal for a kind that has no secret", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([]);
    create.mockResolvedValue({ id: "c1", kind: "email", label: "d…z@e.com", createdAt: 0 });

    renderCard();
    await screen.findByText(/No delivery channels yet/i);

    await user.click(screen.getByRole("button", { name: /Add channel/i }));
    await user.type(screen.getByLabelText(/Email address/i), "deniz@example.com");
    await user.click(screen.getByRole("button", { name: /^Add channel$/ }));

    expect(toastSuccess).toHaveBeenCalledWith("Delivery channel added");
    expect(screen.queryByText(/only time it is shown/i)).not.toBeInTheDocument();
  });

  // The whole reason the button is worth having: it reports what the receiver
  // said, not that something went wrong.
  it("passes the receiver's own words back from a failed test", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([WEBHOOK]);
    const { ApiError } = await import("@/lib/api-client");
    test.mockRejectedValue(new ApiError(502, "upstream 500: service unavailable"));

    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Send a test/ }));

    expect(toastError).toHaveBeenCalledWith("upstream 500: service unavailable");
  });

  it("names the channel it just tested", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([WEBHOOK]);
    test.mockResolvedValue(undefined);

    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Send a test/ }));

    expect(toastSuccess).toHaveBeenCalledWith("Test sent to deploy.acme.example/…7f2c");
  });
});
