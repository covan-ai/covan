import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WebhookDelivery, WebhookEndpoint } from "@/lib/api-client";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  rotate: vi.fn(),
  test: vi.fn(),
  resend: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  role: { me: { id: "u1" } as object | undefined, isAdmin: true },
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    webhooks: {
      list: h.list,
      create: h.create,
      update: h.update,
      remove: h.remove,
      rotate: h.rotate,
      test: h.test,
      resend: h.resend,
    },
  },
  ApiError: class ApiError extends Error {},
  WEBHOOK_EVENTS: ["thread.finished", "agent.needs_you", "routine.failed", "document.created"],
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));
vi.mock("@/lib/workspace-role", () => ({ useWorkspaceRole: () => h.role }));

import { WebhooksSection } from "./webhooks-section";

const ENDPOINT: WebhookEndpoint = {
  id: "w1",
  url: "https://hooks.acme.test/covan",
  events: ["thread.finished", "agent.needs_you"],
  createdBy: "u1",
  createdAt: Date.UTC(2026, 9, 1),
  enabled: true,
};

const delivery = (over: Partial<WebhookDelivery>): WebhookDelivery => ({
  id: "d1",
  endpointId: "w1",
  event: "thread.finished",
  status: "ok",
  attempt: 1,
  statusCode: 200,
  latencyMs: 84,
  error: null,
  createdAt: Date.now() - 5 * 60_000,
  deliveredAt: Date.now() - 5 * 60_000,
  ...over,
});

function renderSection() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WebhooksSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = { me: { id: "u1" }, isAdmin: true };
  h.list.mockResolvedValue({ events: [], endpoints: [ENDPOINT], deliveries: [] });
});

describe("WebhooksSection", () => {
  it("is an admin's: a member is told so and nothing is fetched", () => {
    h.role = { me: { id: "u2" }, isAdmin: false };
    renderSection();

    expect(screen.getByText(/owners and admins set up webhooks/i)).toBeInTheDocument();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("asks for an address and the events when there is no endpoint yet", async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue({ events: [], endpoints: [], deliveries: [] });
    h.create.mockResolvedValue({ ...ENDPOINT, secret: "whsec_thewholesecret" });
    renderSection();

    const url = await screen.findByLabelText("Endpoint");
    expect(screen.getByRole("button", { name: /add endpoint/i })).toBeDisabled();
    await user.type(url, "https://hooks.acme.test/covan");
    await user.click(screen.getByRole("checkbox", { name: /routine\.failed/ }));
    await user.click(screen.getByRole("button", { name: /add endpoint/i }));

    expect(h.create).toHaveBeenCalledWith({
      url: "https://hooks.acme.test/covan",
      events: ["thread.finished", "agent.needs_you", "routine.failed"],
    });
  });

  it("shows the signing secret once, after the endpoint is made", async () => {
    const user = userEvent.setup();
    h.list
      .mockResolvedValueOnce({ events: [], endpoints: [], deliveries: [] })
      .mockResolvedValue({ events: [], endpoints: [ENDPOINT], deliveries: [] });
    h.create.mockResolvedValue({ ...ENDPOINT, secret: "whsec_thewholesecret" });
    renderSection();

    await user.type(await screen.findByLabelText("Endpoint"), "https://hooks.acme.test/covan");
    await user.click(screen.getByRole("button", { name: /add endpoint/i }));

    expect(await screen.findByText("whsec_thewholesecret")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /i have saved it/i }));
    expect(screen.queryByText("whsec_thewholesecret")).not.toBeInTheDocument();
    expect(screen.getByText(/whsec_•+/)).toBeInTheDocument();
  });

  it("saves the events as they are ticked", async () => {
    const user = userEvent.setup();
    h.update.mockResolvedValue(ENDPOINT);
    renderSection();

    const box = await screen.findByRole("checkbox", { name: /document\.created/ });
    expect(screen.getByRole("checkbox", { name: /thread\.finished/ })).toBeChecked();
    expect(box).not.toBeChecked();
    await user.click(box);

    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith("w1", {
        events: ["thread.finished", "agent.needs_you", "document.created"],
      }),
    );
  });

  it("asks before rotating the secret, then shows the new one", async () => {
    const user = userEvent.setup();
    h.rotate.mockResolvedValue({ ...ENDPOINT, secret: "whsec_brandnew" });
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/old secret stops working at once/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Rotate" }));

    expect(await screen.findByText("whsec_brandnew")).toBeInTheDocument();
    expect(h.rotate).toHaveBeenCalledWith("w1");
  });

  it("lists the day's deliveries and offers Resend only on the ones that gave up", async () => {
    const user = userEvent.setup();
    h.resend.mockResolvedValue(undefined);
    h.list.mockResolvedValue({
      events: [],
      endpoints: [ENDPOINT],
      deliveries: [
        delivery({ id: "d1" }),
        delivery({ id: "d2", status: "failed", statusCode: 503, attempt: 4, latencyMs: null }),
      ],
    });
    renderSection();

    expect(await screen.findByText(/· 200 · 84 ms/)).toBeInTheDocument();
    expect(screen.getByText(/· 503 after 4 tries/)).toBeInTheDocument();
    const resend = screen.getAllByRole("button", { name: "Resend" });
    expect(resend).toHaveLength(1);
    await user.click(resend[0]);

    await waitFor(() => expect(h.resend).toHaveBeenCalledWith("d2"));
  });

  it("sends a test and says how it went", async () => {
    const user = userEvent.setup();
    h.test.mockResolvedValue({ deliveryId: "d9", status: "ok", statusCode: 200, latencyMs: 91 });
    renderSection();

    await user.click(await screen.findByRole("button", { name: /send a test/i }));

    await waitFor(() => expect(h.success).toHaveBeenCalledWith("Test delivered · 200 · 91 ms"));
  });

  it("links to how a signature is verified", async () => {
    renderSection();

    expect(await screen.findByRole("link", { name: /how to verify/i })).toHaveAttribute(
      "href",
      "https://covan.app/docs/api#webhooks",
    );
  });
});
