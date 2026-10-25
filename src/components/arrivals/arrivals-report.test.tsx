import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { ArrivalBucket, ArrivalScan } from "@/lib/arrivals";

/**
 * The report: what arrived, and the routines it proposes. The two numbers, a
 * row per kind, three proposals switched on, and "Turn these on" making each
 * routine once — however many times it is pressed, and whatever fails
 * half-way.
 */
const { create, setRoutine, listChannels } = vi.hoisted(() => ({
  create: vi.fn(),
  setRoutine: vi.fn(),
  listChannels: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    routines: { create },
    arrivals: { setRoutine },
    deliveryChannels: { list: listChannels },
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={Object.entries(params ?? {}).reduce((p, [k, v]) => p.replace(`$${k}`, v), to)}>
      {children}
    </a>
  ),
}));

const { ArrivalsReport } = await import("./arrivals-report");
const { turnOn } = await import("./turn-on");

const t = ((key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(options?.[k] ?? ""))) as never;

function bucket(over: Partial<ArrivalBucket>): ArrivalBucket {
  return {
    kind: "other",
    label: "",
    count: 1,
    unanswered: 0,
    examples: [],
    templateId: null,
    routineId: null,
    ...over,
  };
}

function scan(over: Partial<ArrivalScan> = {}): ArrivalScan {
  return {
    id: "scan-1",
    workspaceId: "ws-1",
    userId: "u-1",
    status: "done",
    taxonomy: 1,
    sources: [{ connectionId: "c-1", toolkit: "gmail" }],
    windowDays: 30,
    total: 40,
    unanswered: 6,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-10-26T09:00:00.000Z",
    buckets: [
      bucket({ kind: "automated", count: 15 }),
      bucket({
        kind: "question",
        label: "Order questions",
        count: 10,
        unanswered: 4,
        examples: ["Is the spring order still on?"],
        templateId: "arrivals-questions",
      }),
      bucket({ kind: "request", count: 6, unanswered: 2, templateId: "arrivals-requests" }),
      bucket({ kind: "scheduling", count: 5, templateId: "arrivals-day-ahead" }),
      bucket({ kind: "admin", count: 4, templateId: "arrivals-admin" }),
    ],
    ...over,
  };
}

function renderReport(
  s: ArrivalScan,
  handlers: Partial<{ onDone: (n: number) => void; onRetry: () => void; onSkip: () => void }> = {},
) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ArrivalsReport
        scan={s}
        agentId="agent-1"
        email="ada@acme.test"
        onDone={handlers.onDone ?? vi.fn()}
        onRetry={handlers.onRetry ?? vi.fn()}
        onSkip={handlers.onSkip ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  create.mockReset();
  setRoutine.mockReset();
  listChannels.mockReset();
  listChannels.mockResolvedValue([]);
  setRoutine.mockResolvedValue({ ok: true });
});

describe("ArrivalsReport", () => {
  it("leads with the two numbers", () => {
    renderReport(scan());
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("lists every kind, named in the person's words where the model named it", () => {
    renderReport(scan());
    expect(screen.getByText("Order questions")).toBeTruthy();
    expect(screen.getByText("Notifications and newsletters")).toBeTruthy();
    expect(screen.getByText("Requests and approvals")).toBeTruthy();
  });

  it("shows who is still waiting only on questions and requests", () => {
    renderReport(scan());
    expect(screen.getAllByText(/never got a reply/i).length).toBeGreaterThanOrEqual(2);
    const automated = screen.getByText("Notifications and newsletters").closest("li")!;
    expect(within(automated).queryByText(/never got a reply/i)).toBeNull();
  });

  it("switches on the first three proposals and leaves the rest off", () => {
    renderReport(scan());
    const switches = screen.getAllByRole("switch");
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "false",
    ]);
  });

  it("says where the digests will go", () => {
    renderReport(scan());
    expect(screen.getByText(/ada@acme\.test/)).toBeTruthy();
  });

  it("shows a routine already made from a bucket as on, with no switch", () => {
    renderReport(
      scan({
        buckets: [
          bucket({
            kind: "question",
            count: 3,
            templateId: "arrivals-questions",
            routineId: "r-1",
          }),
        ],
      }),
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("link", { name: /on/i }).getAttribute("href")).toContain("r-1");
  });

  it("offers to try again when the scan failed", async () => {
    const onRetry = vi.fn();
    renderReport(scan({ status: "failed", error: "The grant has expired", buckets: [] }), {
      onRetry,
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("says it is still reading while the scan runs", () => {
    renderReport(scan({ status: "running", total: null, buckets: [] }));
    expect(screen.getByText(/Reading your last thirty days/)).toBeTruthy();
  });

  it("says so when nothing arrived", () => {
    renderReport(scan({ total: 0, unanswered: 0, buckets: [] }));
    expect(screen.getByText(/Nothing arrived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn these on" })).toBeNull();
  });

  it("turns the picked proposals on and says how many", async () => {
    create.mockImplementation(async () => ({
      id: `r-${create.mock.calls.length}`,
      deliveryChannelId: "ch-1",
    }));
    const onDone = vi.fn();
    renderReport(scan(), { onDone });
    await userEvent.click(screen.getByRole("button", { name: "Turn these on" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(3));
    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe("turnOn", () => {
  const base = { agentId: "agent-1", email: "ada@acme.test", timezone: "Europe/Istanbul", t };

  it("makes the first routine with the address and the rest on the channel it made", async () => {
    create
      .mockResolvedValueOnce({ id: "r-1", deliveryChannelId: "ch-1" })
      .mockResolvedValueOnce({ id: "r-2", deliveryChannelId: "ch-1" });
    const out = await turnOn({ ...base, scan: scan(), picked: ["question", "request"] });
    expect(out).toEqual({ created: 2, failed: false });
    expect(create.mock.calls[0][0]).toMatchObject({
      agentId: "agent-1",
      sourceKind: "none",
      deliveryEmail: "ada@acme.test",
      deliverInbox: true,
      scheduleCron: "0 9 * * *",
      timezone: "Europe/Istanbul",
    });
    expect(create.mock.calls[0][0].instruction).toContain("Order questions");
    expect(create.mock.calls[0][0].deliveryChannelId).toBeUndefined();
    expect(create.mock.calls[1][0]).toMatchObject({ deliveryChannelId: "ch-1" });
    expect(create.mock.calls[1][0].deliveryEmail).toBeUndefined();
    // A bucket with no label of its own is named by its kind.
    expect(create.mock.calls[1][0].instruction).toContain("Requests and approvals");
    expect(setRoutine.mock.calls).toEqual([
      ["scan-1", "question", "r-1"],
      ["scan-1", "request", "r-2"],
    ]);
  });

  it("uses a confirmed channel the person already has at that address", async () => {
    listChannels.mockResolvedValue([
      { id: "ch-old", kind: "email", label: "a…a@acme.test", confirmed: true, createdAt: 0 },
    ]);
    create.mockResolvedValue({ id: "r-1", deliveryChannelId: "ch-old" });
    await turnOn({ ...base, scan: scan(), picked: ["question"] });
    expect(create.mock.calls[0][0]).toMatchObject({ deliveryChannelId: "ch-old" });
  });

  it("skips a bucket that already has its routine, so a second press makes nothing twice", async () => {
    const done = scan({
      buckets: [
        bucket({ kind: "question", count: 3, templateId: "arrivals-questions", routineId: "r-1" }),
      ],
    });
    const out = await turnOn({ ...base, scan: done, picked: ["question"] });
    expect(out).toEqual({ created: 0, failed: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("stops at the first failure, keeping what it made", async () => {
    create
      .mockResolvedValueOnce({ id: "r-1", deliveryChannelId: "ch-1" })
      .mockRejectedValueOnce(new Error("boom"));
    const out = await turnOn({
      ...base,
      scan: scan(),
      picked: ["question", "request", "scheduling"],
    });
    expect(out).toEqual({ created: 1, failed: true });
    expect(setRoutine).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
