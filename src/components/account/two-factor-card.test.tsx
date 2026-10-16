import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mfa = vi.hoisted(() => ({
  verifiedAuthenticators: vi.fn(),
  startEnrollment: vi.fn(),
  confirmEnrollment: vi.fn(),
  abandonEnrollment: vi.fn(async () => {}),
  removeAuthenticator: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/mfa", () => mfa);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { TwoFactorCard } = await import("./two-factor-card");

const PHONE = {
  id: "factor-1",
  friendly_name: "Work phone",
  factor_type: "totp",
  status: "verified",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/** The button, once the list of authenticators has arrived and enabled it. */
async function setUpButton() {
  const button = await screen.findByRole("button", { name: "Set up" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TwoFactorCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mfa.verifiedAuthenticators.mockResolvedValue([]);
  mfa.startEnrollment.mockResolvedValue({
    factorId: "new-factor",
    qrCode: "data:image/svg+xml;utf-8,<svg/>",
    secret: "JBSWY3DPEHPK3PXP",
  });
  mfa.confirmEnrollment.mockResolvedValue(undefined);
});

describe("two-step sign-in in account settings", () => {
  it("offers to set it up when there is no authenticator", async () => {
    renderCard();

    expect(await setUpButton()).toBeEnabled();
  });

  it("turns on with a device name, a scan and a first code", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await setUpButton());
    await user.type(screen.getByLabelText(/device name/i), "Work phone");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mfa.startEnrollment).toHaveBeenCalledWith("Work phone");
    expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument();
    // For a person who cannot scan: the key, typed in by hand.
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/code from the app/i), "123 456");
    await user.click(screen.getByRole("button", { name: "Turn on" }));

    expect(mfa.confirmEnrollment).toHaveBeenCalledWith("new-factor", "123456");
  });

  it("clears a setup abandoned before its first code", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await setUpButton());
    await user.type(screen.getByLabelText(/device name/i), "Work phone");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByAltText(/qr code/i);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(mfa.abandonEnrollment).toHaveBeenCalledWith("new-factor"));
  });

  it("keeps the dialog open on a wrong code", async () => {
    mfa.confirmEnrollment.mockRejectedValueOnce(new Error("Invalid TOTP code entered"));
    const user = userEvent.setup();
    renderCard();

    await user.click(await setUpButton());
    await user.type(screen.getByLabelText(/device name/i), "Work phone");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText(/code from the app/i), "000000");
    await user.click(screen.getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("Invalid TOTP code entered")).toBeInTheDocument();
    expect(screen.getByAltText(/qr code/i)).toBeInTheDocument();
  });

  it("lists the devices once it is on, and says there are no backup codes", async () => {
    mfa.verifiedAuthenticators.mockResolvedValue([PHONE]);
    renderCard();

    expect(await screen.findByText("Work phone")).toBeInTheDocument();
    expect(screen.getByText(/no backup codes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add another device" })).toBeEnabled();
  });

  it("warns that removing the only device turns it off", async () => {
    mfa.verifiedAuthenticators.mockResolvedValue([PHONE]);
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/turns two-step sign-in off/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(mfa.removeAuthenticator).toHaveBeenCalledWith("factor-1");
  });
});
