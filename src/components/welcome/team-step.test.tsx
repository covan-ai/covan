import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { updateWorkspace, createInvitation, toast } = vi.hoisted(() => ({
  updateWorkspace: vi.fn(),
  createInvitation: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({
  api: { workspace: { update: updateWorkspace }, invitations: { create: createInvitation } },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/invite-text", () => ({ copyInviteText: vi.fn() }));

import { TeamStep } from "./team-step";

function renderStep(currentName = "Ada's Workspace") {
  const onDone = vi.fn();
  const onValidityChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamStep
        formId="f"
        currentName={currentName}
        onDone={onDone}
        onValidityChange={onValidityChange}
      />
    </QueryClientProvider>,
  );
  return { onDone, onValidityChange };
}

const submit = () => fireEvent.submit(screen.getByLabelText("Workspace name").closest("form")!);

beforeEach(() => {
  updateWorkspace.mockReset().mockResolvedValue({});
  createInvitation.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
});

describe("TeamStep", () => {
  it("needs a name, and nothing else", async () => {
    const { onDone, onValidityChange } = renderStep();
    const user = userEvent.setup();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    await user.clear(screen.getByLabelText("Workspace name"));
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    submit();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("writes nothing when the name is unchanged and no one is invited", async () => {
    const { onDone } = renderStep();
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("renames, then invites each address it was given", async () => {
    createInvitation.mockResolvedValue({ email: "x", emailed: true });
    const { onDone } = renderStep();
    const user = userEvent.setup();

    const name = screen.getByLabelText("Workspace name");
    await user.clear(name);
    await user.type(name, "Acme");
    await user.type(screen.getByLabelText("Invite teammates"), "ada@acme.test, grace@acme.test");
    submit();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(updateWorkspace).toHaveBeenCalledWith({ name: "Acme" });
    expect(createInvitation).toHaveBeenCalledTimes(2);
    expect(createInvitation).toHaveBeenCalledWith({ email: "grace@acme.test", role: "member" });
  });

  it("stays put when no invitation landed, so the addresses can be fixed", async () => {
    createInvitation.mockRejectedValue(new Error("nope"));
    const { onDone } = renderStep();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Invite teammates"), "bad@acme.test");
    submit();

    await waitFor(() => expect(createInvitation).toHaveBeenCalled());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });
});
