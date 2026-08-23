import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InviteStep } from "./invite-step";

const { create, invalidateQueries, toast } = vi.hoisted(() => ({
  create: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-client", () => ({
  api: { invitations: { create } },
  ApiError: class ApiError extends Error {},
}));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateQueries.mockResolvedValue(undefined);
});

async function invite(emails: string[]) {
  const user = userEvent.setup();
  for (const [i, email] of emails.entries()) {
    await user.type(screen.getByLabelText(new RegExp(`teammate ${i + 1} email`, "i")), email);
  }
  await user.click(screen.getByRole("button", { name: /send invitations/i }));
}

describe("InviteStep", () => {
  it("does not claim an email was sent when the install has no mail", async () => {
    // The exact regression: three rows, three rows' worth of "sent", and an
    // install with no RESEND_API_KEY behind it.
    create.mockImplementation(async ({ email }: { email: string }) => ({ email, emailed: false }));
    const onDone = vi.fn();
    render(<InviteStep onDone={onDone} />);

    await invite(["a@x.com", "b@x.com"]);

    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("no email went out"));
    expect(onDone).toHaveBeenCalled();
  });

  it("says plainly that they were emailed when they were", async () => {
    create.mockImplementation(async ({ email }: { email: string }) => ({ email, emailed: true }));
    render(<InviteStep onDone={vi.fn()} />);

    await invite(["a@x.com", "b@x.com"]);

    expect(toast.success).toHaveBeenCalledWith("2 invitations emailed.");
  });

  it("stays put when every address was refused", async () => {
    create.mockRejectedValue(new Error("nope"));
    const onDone = vi.fn();
    render(<InviteStep onDone={onDone} />);

    await invite(["a@x.com"]);

    expect(toast.error).toHaveBeenCalled();
    // Moving on would make them retype the addresses on a screen built for
    // something else.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("skips straight past when nothing was typed", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<InviteStep onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: /send invitations/i }));

    expect(create).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});
