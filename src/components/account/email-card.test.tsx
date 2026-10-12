import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { updateUser } = vi.hoisted(() => ({ updateUser: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { updateUser } } }));

const { EmailCard } = await import("./email-card");

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  updateUser.mockResolvedValue({ error: null });
});

describe("EmailCard", () => {
  it("asks Supabase for the change, with the link pointed at /confirmed", async () => {
    render(<EmailCard email="ada@acme.test" />);
    await userEvent.type(screen.getByLabelText("New address"), "ada@new.test");
    await userEvent.click(screen.getByRole("button", { name: "Change address" }));

    expect(updateUser).toHaveBeenCalledWith(
      { email: "ada@new.test" },
      { emailRedirectTo: `${window.location.origin}/confirmed` },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "We sent a link to ada@acme.test and to ada@new.test",
    );
    // So /confirmed can tell this change from a sign-up when it finishes.
    expect(localStorage.getItem("covan.pendingEmail")).toBe("ada@new.test");
  });

  it("shows what Supabase refused, in place", async () => {
    updateUser.mockResolvedValue({ error: { message: "Email address already registered" } });
    render(<EmailCard email="ada@acme.test" />);
    await userEvent.type(screen.getByLabelText("New address"), "taken@acme.test");
    await userEvent.click(screen.getByRole("button", { name: "Change address" }));

    expect(await screen.findByText("Email address already registered")).toBeInTheDocument();
    expect(localStorage.getItem("covan.pendingEmail")).toBeNull();
  });

  it("will not send something that is not an address, or the one you already have", async () => {
    render(<EmailCard email="ada@acme.test" />);
    const input = screen.getByLabelText("New address");
    const button = screen.getByRole("button", { name: "Change address" });

    await userEvent.type(input, "not-an-address");
    expect(button).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "ADA@acme.test");
    expect(button).toBeDisabled();
  });
});
