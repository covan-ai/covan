import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const create = vi.fn();
const linkCreate = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { workspace: { name: "Acme" } } }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: vi.fn(),
    invitations: { create: (...a: unknown[]) => create(...a) },
    inviteLinks: { create: (...a: unknown[]) => linkCreate(...a) },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { InviteMemberDialog } from "./invite-member-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  create.mockImplementation(({ email }: { email: string }) =>
    Promise.resolve({ email, emailed: true }),
  );
});

describe("InviteMemberDialog (A25)", () => {
  it("is titled with the workspace, and sends one invitation per address", async () => {
    const onOpenChange = vi.fn();
    render(<InviteMemberDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByRole("heading", { name: "Invite to Acme" })).toBeInTheDocument();

    const field = screen.getByLabelText("Email addresses");
    await userEvent.type(field, "ayse@acme.test,");
    await userEvent.type(field, "baran@acme.test");
    expect(screen.getByText("ayse@acme.test")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(create).toHaveBeenCalledWith({ email: "ayse@acme.test", role: "member" });
    expect(create).toHaveBeenCalledWith({ email: "baran@acme.test", role: "member" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the addresses that were refused, to try again", async () => {
    create.mockImplementation(({ email }: { email: string }) =>
      email.startsWith("no")
        ? Promise.reject(new Error("nope"))
        : Promise.resolve({ email, emailed: true }),
    );
    const onOpenChange = vi.fn();
    render(<InviteMemberDialog open onOpenChange={onOpenChange} />);
    await userEvent.type(screen.getByLabelText("Email addresses"), "ok@acme.test no@acme.test ");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("no@acme.test")).toBeInTheDocument();
    expect(screen.queryByText("ok@acme.test")).not.toBeInTheDocument();
  });

  it("copies a link that works for seven days", async () => {
    linkCreate.mockResolvedValue({ url: "https://covan.test/invite#link=abc" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<InviteMemberDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(linkCreate).toHaveBeenCalledWith("member");
    expect(writeText).toHaveBeenCalledWith("https://covan.test/invite#link=abc");
  });
});
