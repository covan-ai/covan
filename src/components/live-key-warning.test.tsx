import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveKeyWarning } from "./live-key-warning";

const { useQuery, keyCount } = vi.hoisted(() => ({ useQuery: vi.fn(), keyCount: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/api-client", () => ({ api: { workspace: { members: { keyCount } } } }));

function renderWith(data: { count: number | null } | undefined) {
  useQuery.mockReturnValue({ data });
  render(<LiveKeyWarning userId="user-2" />);
}

beforeEach(() => vi.clearAllMocks());

describe("LiveKeyWarning", () => {
  it("says how many keys are about to stop, and what that costs", () => {
    renderWith({ count: 2 });

    expect(screen.getByText(/2 API keys that are still in use/)).toBeInTheDocument();
    expect(screen.getByText(/go quiet/)).toBeInTheDocument();
  });

  it("reads as one sentence for one key", () => {
    renderWith({ count: 1 });

    expect(screen.getByText(/1 API key that is still in use/)).toBeInTheDocument();
    expect(screen.queryByText(/keys that are/)).not.toBeInTheDocument();
  });

  it("says nothing when there is nothing to warn about", () => {
    // The dialog it sits in already says what removal does. A line that says
    // "0 keys" is a line that makes the reader stop and check.
    renderWith({ count: 0 });

    expect(screen.queryByText(/API key/)).not.toBeInTheDocument();
  });

  it("says nothing while the answer has not arrived", () => {
    renderWith(undefined);

    expect(screen.queryByText(/API key/)).not.toBeInTheDocument();
  });

  it("says nothing where the deployment cannot answer at all", () => {
    // `count: null` is the window before 0033 is applied. A warning about a
    // feature this install does not have would be a warning about nothing.
    renderWith({ count: null });

    expect(screen.queryByText(/API key/)).not.toBeInTheDocument();
  });
});
