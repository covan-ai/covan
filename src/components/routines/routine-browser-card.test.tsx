import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineBrowserCard } from "./routine-browser-card";
import type { Routine } from "@/lib/routines-api";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const routine: Routine = {
  id: "r1",
  agentId: "a1",
  userId: "me",
  name: "Morning prices",
  visibility: "private",
  sourceKind: "none",
  sourceUrl: null,
  connectionId: null,
  instruction: "check the prices",
  deliveryChannelId: "c1",
  scheduleCron: "0 9 * * *",
  timezone: "UTC",
  triggerKind: "schedule",
  event: null,
  outputBundleId: null,
  outputRetention: 52,
  endsAfterRuns: null,
  runsDone: 0,
  browserAccess: "off",
  browserSite: null,
  browserConversationId: null,
  status: "active",
  pausedReason: null,
  pausedBy: null,
  pausedAt: null,
  deliverInbox: true,
  model: null,
  reasoningEffort: null,
  channelIds: [],
  nextRunAt: null,
  lastRunAt: null,
  createdAt: 0,
};

describe("RoutineBrowserCard", () => {
  it("is off until the owner turns it on, and says what that means", () => {
    render(<RoutineBrowserCard routine={routine} onSave={() => {}} saving={false} />);
    expect(screen.getByLabelText("Allow the browser on scheduled runs")).not.toBeChecked();
    expect(screen.getByText(/Runs cannot use the browser/)).toBeInTheDocument();
  });

  it("turns on as in a conversation", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<RoutineBrowserCard routine={routine} onSave={onSave} saving={false} />);

    await user.click(screen.getByLabelText("Allow the browser on scheduled runs"));
    expect(onSave).toHaveBeenCalledWith({ browserAccess: "all" });
  });

  it("says what `all` carries", () => {
    render(
      <RoutineBrowserCard
        routine={{ ...routine, browserAccess: "all" }}
        onSave={() => {}}
        saving={false}
      />,
    );
    expect(screen.getByText(/carries what yours does in a conversation/)).toBeInTheDocument();
    expect(screen.queryByLabelText("The site it may sign in to")).not.toBeInTheDocument();
  });

  it("asks for the site before saving the one-site choice", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <RoutineBrowserCard
        routine={{ ...routine, browserAccess: "all" }}
        onSave={onSave}
        saving={false}
      />,
    );

    await user.click(screen.getByLabelText("What the browser may use"));
    await user.click(await screen.findByRole("option", { name: "One site's saved login only" }));
    expect(onSave).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("The site it may sign in to"), "linkedin.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ browserAccess: "site", browserSite: "linkedin.com" });
  });

  it("names the one site, and links the conversation the browser works beside", () => {
    render(
      <RoutineBrowserCard
        routine={{
          ...routine,
          browserAccess: "site",
          browserSite: "linkedin.com",
          browserConversationId: "conv-1",
        }}
        onSave={() => {}}
        saving={false}
      />,
    );
    expect(screen.getByText(/starts with none of your sign-ins/)).toHaveTextContent("linkedin.com");
    expect(screen.getByText("this routine's conversation")).toBeInTheDocument();
  });
});
