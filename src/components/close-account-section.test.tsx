import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseAccountSection } from "./close-account-section";

// The error class is hoisted with the mocks rather than declared below them:
// `vi.mock`'s factory runs before any top-level statement in this file, so a
// class defined down there does not exist yet when the factory references it.
const { close, signOut, FakeApiError } = vi.hoisted(() => ({
  close: vi.fn(),
  signOut: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// Mocked whole rather than partially: the real module constructs a Supabase
// client at import time, which needs an origin no unit test has.
vi.mock("@/lib/api-client", () => ({
  api: { account: { close } },
  ApiError: FakeApiError,
}));

vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signOut } } }));

const EMAIL = "a@example.com";

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Close my account" }));
  return screen.getByRole("alertdialog");
}

/** The confirm button inside the dialog, not the trigger that shares its name. */
function confirmButton() {
  return screen.getAllByRole("button", { name: /Close my account|Closing/ }).at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  close.mockResolvedValue({ ok: true });
  signOut.mockResolvedValue(undefined);
});

describe("CloseAccountSection", () => {
  it("says what survives, not only what goes", async () => {
    render(<CloseAccountSection email={EMAIL} />);
    // The surprising half. Somebody closing an account assumes everything they
    // touched leaves with them, and in a shared workspace it does not.
    expect(screen.getByText(/keep running without you/i)).toBeInTheDocument();
  });

  it("refuses to enable the button until the address is typed exactly", async () => {
    render(<CloseAccountSection email={EMAIL} />);
    await openDialog();

    expect(confirmButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/to confirm/i), "a@example.co");
    expect(confirmButton()).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/to confirm/i), "m");
    expect(confirmButton()).toBeEnabled();
    expect(close).not.toHaveBeenCalled();
  });

  it("accepts the address whatever case it is typed in", async () => {
    render(<CloseAccountSection email={EMAIL} />);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/to confirm/i), "A@Example.com");
    expect(confirmButton()).toBeEnabled();
  });

  it("signs out once the server has agreed", async () => {
    render(<CloseAccountSection email={EMAIL} />);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/to confirm/i), EMAIL);
    await userEvent.click(confirmButton());

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    // Holding a token for a user that no longer exists is how the next screen
    // becomes a 401 nobody can explain.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("keeps the dialog open and shows which workspace is in the way", async () => {
    close.mockRejectedValue(
      new FakeApiError(
        409,
        "make someone else an admin first — a workspace cannot be left without one: Acme",
      ),
    );
    render(<CloseAccountSection email={EMAIL} />);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/to confirm/i), EMAIL);
    await userEvent.click(confirmButton());

    // The name is the whole point of the refusal — a count would send somebody
    // hunting through the workspace switcher.
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    // Still pressable: the person fixes the admin role and comes back to it.
    expect(confirmButton()).toBeEnabled();
  });

  it("clears a refusal when the dialog is dismissed", async () => {
    close.mockRejectedValue(new FakeApiError(409, "…: Acme"));
    render(<CloseAccountSection email={EMAIL} />);
    await openDialog();
    await userEvent.type(screen.getByLabelText(/to confirm/i), EMAIL);
    await userEvent.click(confirmButton());
    await screen.findByText(/Acme/);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openDialog();

    expect(screen.queryByText(/Acme/)).not.toBeInTheDocument();
    // And the typed address is gone with it, so reopening is a fresh decision.
    expect(confirmButton()).toBeDisabled();
  });

  it("cannot be confirmed at all when the email has not loaded", async () => {
    render(<CloseAccountSection />);
    await openDialog();
    // An empty expected value would otherwise make an empty box a match.
    expect(confirmButton()).toBeDisabled();
  });
});
