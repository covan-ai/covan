import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceCoverageSection } from "./workspace-coverage-section";
import type { CoverageResponse } from "@/lib/api-client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { coverage: vi.fn() } }));

const HEADING = "What nothing was close to.";

const response = (patch: Partial<CoverageResponse> = {}): CoverageResponse =>
  ({
    available: true,
    days: 30,
    totals: { answers: 100, covered: 62, fallback: 31, ungrounded: 7, unrecorded: 0 },
    agents: [
      {
        agentId: "agent-1",
        name: "Handbook",
        emoji: "📘",
        answers: 60,
        covered: 20,
        fallback: 36,
        ungrounded: 4,
      },
      {
        agentId: "agent-2",
        name: "GTM",
        emoji: "📈",
        answers: 40,
        covered: 34,
        fallback: 5,
        ungrounded: 1,
      },
    ],
    ...patch,
  }) as CoverageResponse;

function renderWith(data: CoverageResponse | undefined, isLoading = false) {
  useQuery.mockReturnValue({ data, isLoading, isPending: isLoading });
  return render(<WorkspaceCoverageSection />);
}

beforeEach(() => vi.clearAllMocks());

describe("WorkspaceCoverageSection", () => {
  it("leads with the share of answers that stood on something the team wrote", () => {
    renderWith(response());

    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText(/of 100 replies in the last 30 days/)).toBeInTheDocument();
  });

  it("names all three buckets with their counts, not just the good one", () => {
    renderWith(response());

    expect(screen.getByText("Stood on a passage")).toBeInTheDocument();
    expect(screen.getByText("Fell back to whole documents")).toBeInTheDocument();
    expect(screen.getByText("Nothing to stand on")).toBeInTheDocument();
    expect(screen.getByText(/^31/)).toBeInTheDocument();
  });

  // 0053 orders by the misses so the agent most in need of somebody writing
  // something down is first. The renderer keeps that order rather than
  // imposing one of its own, which is the only reason the list is useful at a
  // glance.
  it("keeps the order the function returned, worst first", () => {
    renderWith(response());

    const names = screen.getAllByText(/^(Handbook|GTM)$/).map((el) => el.textContent);
    expect(names).toEqual(["Handbook", "GTM"]);
  });

  // A third is the point past which the sentence changes from "people ask
  // about things no handbook has" to "most of what this agent is asked is not
  // in what it was given". Amber is the pointer at that, and is spent nowhere
  // else on this screen.
  it("points at the agent whose misses are worth acting on, and not at the others", () => {
    const { container } = renderWith(response());

    // Handbook: 40 of 60 missed — two thirds.
    expect(screen.getByText("67% not covered")).toBeInTheDocument();
    // GTM: 6 of 40 — ordinary, and left neutral.
    expect(screen.getByText("15% not covered")).toBeInTheDocument();

    // The design contract, not a detail: amber is a pointer in this system,
    // and a pointer aimed at several rows at once is a highlight. One chip
    // carries it, and it is the worst row.
    const amber = container.querySelectorAll(".bg-accent-orange");
    expect(amber).toHaveLength(1);
    expect(amber[0]).toHaveTextContent("67% not covered");
  });

  // Every row is above the threshold here, and exactly one is still allowed
  // to be amber.
  it("spends the accent once even when every agent is badly covered", () => {
    const { container } = renderWith(
      response({
        agents: [
          {
            agentId: "a",
            name: "One",
            emoji: null,
            answers: 10,
            covered: 1,
            fallback: 8,
            ungrounded: 1,
          },
          {
            agentId: "b",
            name: "Two",
            emoji: null,
            answers: 10,
            covered: 2,
            fallback: 7,
            ungrounded: 1,
          },
          {
            agentId: "c",
            name: "Three",
            emoji: null,
            answers: 10,
            covered: 3,
            fallback: 6,
            ungrounded: 1,
          },
        ],
      }),
    );

    expect(container.querySelectorAll(".bg-accent-orange")).toHaveLength(1);
  });

  // 0053 returns every agent, including the ones nobody asked anything. They
  // are deliberately not rows — a list of zeroes buries the agents with
  // figures — and deliberately not dropped either.
  it("counts the agents nobody asked anything, without listing them as zeroes", () => {
    renderWith(
      response({
        agents: [
          {
            agentId: "agent-1",
            name: "Handbook",
            emoji: "📘",
            answers: 60,
            covered: 20,
            fallback: 36,
            ungrounded: 4,
          },
          {
            agentId: "agent-3",
            name: "Dormant",
            emoji: "💤",
            answers: 0,
            covered: 0,
            fallback: 0,
            ungrounded: 0,
          },
        ],
      }),
    );

    expect(screen.queryByText("Dormant")).not.toBeInTheDocument();
    expect(screen.getByText("1 agent nobody asked anything in this window.")).toBeInTheDocument();
  });

  it("switches the window without losing the section", async () => {
    renderWith(response());

    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "7d" }));

    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "false");
  });

  // CI does not apply migrations, so there is a real window in which the API
  // is deployed and 0053 is not. An admin should see nothing at all there.
  it("renders nothing at all until the migration behind it exists", () => {
    renderWith(response({ available: false }));

    expect(screen.queryByText(HEADING)).not.toBeInTheDocument();
  });

  it("renders nothing while it is still loading, rather than an empty shell", () => {
    renderWith(undefined, true);

    expect(screen.queryByText(HEADING)).not.toBeInTheDocument();
  });

  it("says out loud that nothing here is per-person", () => {
    renderWith(response());

    expect(screen.getByText(/never by person/i)).toBeInTheDocument();
  });

  // The denominator excludes replies written before 0039, so a workspace whose
  // history predates it would otherwise read its first report as a census when
  // it is a sample.
  it("declares the replies that predate the recording", () => {
    renderWith(
      response({
        totals: { answers: 100, covered: 62, fallback: 31, ungrounded: 7, unrecorded: 240 },
      }),
    );

    expect(
      screen.getByText(/240 replies in this window predate the recording/),
    ).toBeInTheDocument();
  });

  it("says nothing yet rather than 0% when the window is empty", () => {
    renderWith(
      response({
        totals: { answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 0 },
        agents: [],
      }),
    );

    expect(screen.getByText("Nothing in this window")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});
