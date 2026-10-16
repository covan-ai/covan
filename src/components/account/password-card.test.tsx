import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { updateUser, signOut, reauthenticate } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  signOut: vi.fn(),
  reauthenticate: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  supabase: { auth: { updateUser, signOut, reauthenticate } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { PasswordCard } = await import("./password-card");

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue({ error: null });
  reauthenticate.mockResolvedValue({ error: null });
});

async function fill(password: string, confirm: string) {
  await userEvent.type(screen.getByLabelText("New password"), password);
  await userEvent.type(screen.getByLabelText("Confirm new password"), confirm);
}

describe("PasswordCard", () => {
  // Eight, as sign-up and the reset page ask, and as GoTrue enforces.
  it("refuses a password under eight characters", async () => {
    render(<PasswordCard />);
    await fill("abcdefg", "abcdefg");
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();
  });

  it("refuses two that do not match", async () => {
    render(<PasswordCard />);
    await fill("correct horse", "correct hose");
    expect(screen.getByText("The two do not match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();
  });

  // This is the session you are using, not a recovery link somebody forwarded,
  // so unlike the reset page it keeps you signed in.
  it("changes it, clears the fields, and leaves you signed in", async () => {
    render(<PasswordCard />);
    await fill("correct horse", "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(updateUser).toHaveBeenCalledWith({ password: "correct horse" });
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveValue(""));
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("shows what Supabase refused", async () => {
    updateUser.mockResolvedValue({ error: { message: "New password should be different" } });
    render(<PasswordCard />);
    await fill("same-as-before", "same-as-before");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByText("New password should be different")).toBeInTheDocument();
  });

  // `secure_password_change`: a session that has not signed in within the
  // last day is asked for a code GoTrue emails, so a laptop left open cannot
  // lock its owner out.
  it("asks for the emailed code when GoTrue wants proof, then sends it", async () => {
    updateUser.mockResolvedValueOnce({
      error: {
        code: "reauthentication_needed",
        message: "Password update requires reauthentication",
      },
    });
    render(<PasswordCard />);
    await fill("correct horse", "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(reauthenticate).toHaveBeenCalled();
    const codeField = await screen.findByLabelText("Code from your email");
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();

    await userEvent.type(codeField, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(updateUser).toHaveBeenLastCalledWith({ password: "correct horse", nonce: "123456" });
    await waitFor(() => expect(screen.queryByLabelText("Code from your email")).toBeNull());
  });
});
